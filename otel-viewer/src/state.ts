import type { AssistantMessage, SpanJson } from "./types.ts";
import { generateSpanId, generateTraceId, nowMs, truncate } from "./utils.ts";

const RESOURCE: Record<string, unknown> = {
  "service.name": "pi",
  "otel.viewer.instrumentation": "pi-extension-otel-viewer",
};

/**
 * pi tool result 常为 {content:[{type:"text",text:"..."},...]}。
 * 提取 text 拼接为纯文本，避免 JSON 转义符且不受 truncate 截断影响。
 * 非 pi 格式返回 null，回退到 JSON.stringify。
 */
function extractTextFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content)) return null;
  const texts: string[] = [];
  for (const c of r.content) {
    if (
      c &&
      typeof c === "object" &&
      (c as { type?: string }).type === "text" &&
      typeof (c as { text?: string }).text === "string"
    ) {
      texts.push((c as { text: string }).text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

interface PendingTool {
  toolCallId: string;
  toolName: string;
  startedAt: number;
}

/**
 * subagent 类工具：派生独立子进程，需提前创建 span 并通过 env 传 parent spanId。
 * 匹配 pi-subagents 的 subagent / subagent_supervisor / subagent_wait。
 */
function isSubagentTool(name: string): boolean {
  return name.startsWith("subagent");
}

/**
 * 管理单个 pi session 的 span 树状态。
 *
 * Span 树层级：
 *   Root (pi.session, INTERNAL)
 *   ├── Turn (pi.turn, INTERNAL)          ← before_agent_start
 *   │   ├── LLM (pi.llm, CLIENT)          ← message_start→message_end
 *   │   │   └── Tool (pi.tool.<name>)     ← tool_execution_start→end
 *   │   └── ...
 *   ├── Compaction (pi.compaction)        ← session_before_compact→compact
 *   └── Branch (pi.branch)                ← session_before_tree→tree
 */
export class SessionState {
  private traceId: string | null = null;
  private sessionId: string | null = null;
  private rootSpan: SpanJson | null = null;

  private currentTurn: SpanJson | null = null;

  // toolCallId → 发起该 toolCall 的 LLM span 的 spanId
  private toolCallToLlm: Map<string, string> = new Map();

  // 正在执行的 tool（start 已触发，还没 end）
  private pendingTools: Map<string, PendingTool> = new Map();

  // subagent 工具：start 时已提前创建的 span（待 end 时填充 result 并结束）
  private preCreatedSubagentSpans: Map<string, SpanJson> = new Map();

  // LLM 调用开始时间（message_start 记录，message_end 用）
  private llmStartedAt: number | null = null;

  // compaction / branch 的 open span
  private compactionSpan: SpanJson | null = null;
  private branchSpan: SpanJson | null = null;

  // 已完成、待上报的 span
  private completed: SpanJson[] = [];

  private started = false;

  // ===== Session =====

  isStarted(): boolean {
    return this.started;
  }

  startSession(sessionId: string): void {
    // reload 或新 session 前先清理旧状态
    if (this.started) {
      this.finalize();
    }
    this.traceId = generateTraceId();
    this.sessionId = sessionId;
    this.started = true;

    // 子进程：从 env 读主 agent 传来的 parent span id
    // （主 agent 的 pi.tool.subagent span，在 tool_execution_start 时创建并写入 env）
    // 子进程继承 process.env（pi-subagents spawn 用 { ...process.env, ... }）
    const envParentSpanId = process.env.PI_OTEL_PARENT_SPAN_ID || null;
    if (envParentSpanId) {
      // 读完即删，避免孙 agent 误继承
      delete process.env.PI_OTEL_PARENT_SPAN_ID;
      delete process.env.PI_OTEL_PARENT_TRACE_ID;
    }

    this.rootSpan = this.createSpan({
      parentSpanId: envParentSpanId,
      name: "pi.session",
      kind: "INTERNAL",
      startMs: nowMs(),
      attributes: envParentSpanId ? { "pi.session.is_subagent": true } : {},
    });
  }

  // ===== Turn =====

  startTurn(prompt?: string): void {
    if (!this.canCreate()) return;
    // 若已有 turn，先结束（被新 prompt 替换）
    if (this.currentTurn) {
      this.finishTurn("replaced_by_new_prompt");
    }
    this.currentTurn = this.createSpan({
      parentSpanId: this.rootSpan!.spanId,
      name: "pi.turn",
      kind: "INTERNAL",
      startMs: nowMs(),
      attributes: prompt ? { "pi.turn.prompt": truncate(prompt, 500) } : {},
    });

    // 首条 user prompt 作为 session summary，挂到 root span。
    // 后端 list_sessions/get_session 的 title 回退会读取 pi.session.summary
    // （PI session_id 是随机值，跨库查 opencode.db 拿不到 title）。
    if (
      prompt &&
      this.rootSpan &&
      !this.rootSpan.attributes["pi.session.summary"]
    ) {
      this.rootSpan.attributes["pi.session.summary"] = truncate(prompt, 200);
    }
  }

  finishTurn(reason?: string): void {
    if (!this.currentTurn) return;
    this.endSpan(this.currentTurn, {
      attributes: reason ? { "pi.turn.end_reason": reason } : {},
    });
    this.completed.push(this.currentTurn);
    this.currentTurn = null;
    // turn 结束后清理 toolCall 映射
    this.toolCallToLlm.clear();
  }

  // ===== LLM =====

  recordLlmStart(): void {
    this.llmStartedAt = nowMs();
  }

  recordLlmEnd(message: AssistantMessage): void {
    if (!this.canCreate() || !this.currentTurn) return;

    // 跳过空 message_end（pi 对 thinking 模型偶发先发一轮无 usage/provider/model
    // 的空 message 事件，是噪声；只保留含真实 LLM 调用信息的 message）
    const hasUsage =
      message.usage != null &&
      (message.usage.input != null || message.usage.output != null);
    const hasInfo =
      message.provider ||
      message.model ||
      message.stopReason ||
      message.errorMessage;
    if (!hasUsage && !hasInfo) {
      this.llmStartedAt = null;
      return;
    }

    const startMs = this.llmStartedAt ?? nowMs();
    this.llmStartedAt = null;

    const attrs: Record<string, unknown> = {};
    // 把 turn 的 prompt 带到 llm span，供后端 list_calls 提取为 prompt_summary
    const turnPrompt = this.currentTurn.attributes["pi.turn.prompt"];
    if (turnPrompt) attrs["pi.llm.prompt"] = turnPrompt;
    if (message.provider) attrs["gen_ai.system"] = message.provider;
    if (message.model) attrs["gen_ai.model"] = message.model;
    if (message.stopReason) attrs["gen_ai.stop_reason"] = message.stopReason;
    if (message.usage) {
      const u = message.usage;
      if (u.input != null) attrs["gen_ai.usage.input_tokens"] = u.input;
      if (u.output != null) attrs["gen_ai.usage.output_tokens"] = u.output;
      if (u.cacheRead != null) attrs["gen_ai.usage.cache_read_tokens"] = u.cacheRead;
      if (u.cacheWrite != null) attrs["gen_ai.usage.cache_write_tokens"] = u.cacheWrite;
      if (u.cost?.total != null) attrs["gen_ai.usage.cost_total"] = u.cost.total;
    }
    if (message.errorMessage) attrs["pi.llm.error"] = message.errorMessage;

    const llmSpan = this.createSpan({
      parentSpanId: this.currentTurn.spanId,
      name: "pi.llm",
      kind: "CLIENT",
      startMs,
      attributes: attrs,
    });

    // 扫 toolCall 内容块，建 toolCallId → llmSpanId 映射
    // pi-ai 的 ToolCall block: { type: "toolCall", id, name, arguments }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.id) {
          this.toolCallToLlm.set(block.id, llmSpan.spanId);
        }
      }
    }

    // LLM span 在 message_end 时立即结束（已有完整 output）
    this.endSpan(llmSpan, {
      error: message.errorMessage,
    });
    this.completed.push(llmSpan);
  }

  // ===== Tool =====

  recordToolStart(toolCallId: string, toolName: string): void {
    const startedAt = nowMs();
    this.pendingTools.set(toolCallId, { toolCallId, toolName, startedAt });

    // subagent 工具：提前创建 span（不等 end），把 spanId 通过 env 传给子进程，
    // 使子进程的 pi.session root 的 parent_span_id 指向此 span（跨 trace 关联）。
    // 必须在 tool_execution_start 时创建：spawn 发生在 tool 执行期间，
    // 子进程 session_start 时读 env 拿到 parent spanId。
    if (isSubagentTool(toolName) && this.canCreate()) {
      const parentSpanId =
        this.toolCallToLlm.get(toolCallId) ??
        this.currentTurn?.spanId ??
        null;
      if (!parentSpanId) return;
      const span = this.createSpan({
        parentSpanId,
        name: `pi.tool.${toolName}`,
        kind: "INTERNAL",
        startMs: startedAt,
        attributes: { "pi.tool.name": toolName },
      });
      this.preCreatedSubagentSpans.set(toolCallId, span);
      process.env.PI_OTEL_PARENT_SPAN_ID = span.spanId;
      process.env.PI_OTEL_PARENT_TRACE_ID = span.traceId;
    }
  }

  recordToolEnd(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): void {
    if (!this.canCreate()) return;
    const pending = this.pendingTools.get(toolCallId);
    if (!pending) return;
    this.pendingTools.delete(toolCallId);

    // subagent 工具：span 已在 start 时提前创建，只需 end + 填充 result
    const preCreated = this.preCreatedSubagentSpans.get(toolCallId);
    if (preCreated) {
      this.preCreatedSubagentSpans.delete(toolCallId);
      // 清理 env（子进程已在 session_start 时读完）
      delete process.env.PI_OTEL_PARENT_SPAN_ID;
      delete process.env.PI_OTEL_PARENT_TRACE_ID;

      let resultStr: string;
      const textContent = extractTextFromResult(result);
      if (textContent) {
        resultStr = truncate(textContent);
      } else {
        try {
          resultStr = truncate(JSON.stringify(result));
        } catch {
          resultStr = truncate(String(result));
        }
      }
      this.endSpan(preCreated, {
        error: isError
          ? typeof result === "string"
            ? result
            : "subagent execution error"
          : undefined,
        attributes: {
          "pi.tool.result": resultStr,
          "pi.tool.is_error": isError,
        },
      });
      this.completed.push(preCreated);
      return;
    }

    // 常规工具：start 时未建 span，在此创建 + 结束
    // parent: 发起该 toolCall 的 LLM span，查不到回退 turn
    const parentSpanId =
      this.toolCallToLlm.get(toolCallId) ?? this.currentTurn?.spanId ?? null;
    if (!parentSpanId) return;

    const toolSpan = this.createSpan({
      parentSpanId,
      name: `pi.tool.${toolName}`,
      kind: "INTERNAL",
      startMs: pending.startedAt,
      attributes: {
        "pi.tool.name": toolName,
      },
    });

    let resultStr: string;
    const textContent = extractTextFromResult(result);
    if (textContent) {
      resultStr = truncate(textContent);
    } else {
      try {
        resultStr = truncate(JSON.stringify(result));
      } catch {
        resultStr = truncate(String(result));
      }
    }

    this.endSpan(toolSpan, {
      error: isError
        ? typeof result === "string"
          ? result
          : "tool execution error"
        : undefined,
      attributes: {
        "pi.tool.result": resultStr,
        "pi.tool.is_error": isError,
      },
    });
    this.completed.push(toolSpan);
  }

  // ===== Compaction =====

  startCompaction(reason: string): void {
    if (!this.canCreate()) return;
    this.compactionSpan = this.createSpan({
      parentSpanId: this.rootSpan!.spanId,
      name: "pi.compaction",
      kind: "INTERNAL",
      startMs: nowMs(),
      attributes: { "pi.compaction.reason": reason },
    });
  }

  finishCompaction(): void {
    if (!this.compactionSpan) return;
    this.endSpan(this.compactionSpan);
    this.completed.push(this.compactionSpan);
    this.compactionSpan = null;
  }

  // ===== Branch =====

  startBranch(): void {
    if (!this.canCreate()) return;
    this.branchSpan = this.createSpan({
      parentSpanId: this.rootSpan!.spanId,
      name: "pi.branch",
      kind: "INTERNAL",
      startMs: nowMs(),
      attributes: {},
    });
  }

  finishBranch(newLeafId: string, oldLeafId: string): void {
    if (!this.branchSpan) return;
    this.endSpan(this.branchSpan, {
      attributes: {
        "pi.branch.new_leaf_id": newLeafId,
        "pi.branch.old_leaf_id": oldLeafId,
      },
    });
    this.completed.push(this.branchSpan);
    this.branchSpan = null;
  }

  // ===== Finalize / Drain =====

  /** 结束所有未关闭的 span（session 退出时调用） */
  finalize(): void {
    if (this.currentTurn) this.finishTurn("session_shutdown");
    if (this.compactionSpan) this.finishCompaction();
    if (this.branchSpan) this.finishBranch("", "");

    // 结束未关闭的 subagent span（session 异常退出时可能仍 open）
    for (const span of this.preCreatedSubagentSpans.values()) {
      this.endSpan(span);
      this.completed.push(span);
    }
    this.preCreatedSubagentSpans.clear();

    if (this.rootSpan) {
      this.endSpan(this.rootSpan);
      this.completed.push(this.rootSpan);
      this.rootSpan = null;
    }
    this.started = false;
  }

  /** 取出已完成的 span（清空内部缓冲） */
  drainCompleted(): SpanJson[] {
    const spans = this.completed;
    this.completed = [];
    return spans;
  }

  // ===== 内部工具 =====

  private canCreate(): boolean {
    return this.started && this.traceId !== null && this.sessionId !== null && this.rootSpan !== null;
  }

  private createSpan(args: {
    parentSpanId: string | null;
    name: string;
    kind: string;
    startMs: number;
    attributes?: Record<string, unknown>;
  }): SpanJson {
    return {
      traceId: this.traceId!,
      spanId: generateSpanId(),
      parentSpanId: args.parentSpanId,
      name: args.name,
      kind: args.kind,
      startMs: args.startMs,
      endMs: 0,
      durationMs: 0,
      // 后端 db.lua 从 attributes["session.id"] 提取 session_id（opencode 约定），
      // 必须放在这里，否则 sessions API 过滤掉无 session_id 的 span。
      attributes: { "session.id": this.sessionId!, ...(args.attributes ?? {}) },
      resource: { ...RESOURCE },
      status: { code: "OK" },
      session_id: this.sessionId!,
    };
  }

  private endSpan(
    span: SpanJson,
    opts?: {
      error?: string;
      attributes?: Record<string, unknown>;
    },
  ): void {
    span.endMs = nowMs();
    span.durationMs = span.endMs - span.startMs;
    if (opts?.error) {
      span.status = { code: "ERROR", message: opts.error };
    }
    if (opts?.attributes) {
      span.attributes = { ...span.attributes, ...opts.attributes };
    }
  }
}
