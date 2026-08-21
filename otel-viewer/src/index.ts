import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SqliteClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { SessionState } from "./state.ts";
import { generateInstanceId } from "./utils.ts";
import type { AssistantMessage, OtelViewerConfig } from "./types.ts";

type LogLevel = "info" | "warn" | "error";

/**
 * pi-extension-otel-viewer
 *
 * "pi 版的 otel-viewer"：捕获 pi 的 session/turn/llm/tool 事件，
 * 转成 otel-viewer 兼容的 SpanJson，直接写入本地 SQLite（~/.local/share/pi/otel.db）。
 * Slate 以只读方式同时读 opencode 与 pi 两个 otel.db 合并展示。
 *
 * Span 树：Session → Turn → [LLM → Tool]
 */
export default function (pi: ExtensionAPI): void {
  let client: SqliteClient | null = null;
  let state: SessionState | null = null;
  let config: OtelViewerConfig | null = null;
  // session ID：session_start 时生成，同一 session 的所有 span 共享
  let sessionId: string | null = null;

  // 静默日志：只写 stderr，不污染 pi TUI 底部状态栏。
  const log = (level: LogLevel, msg: string) => {
    if (level === "error") console.error(`[otel-viewer] ${msg}`);
  };

  function ensureInitialized(ctx: { cwd: string }): boolean {
    if (client && state) return true;

    config = loadConfig(ctx.cwd);

    if (!config.enabled) {
      return false;
    }

    client = new SqliteClient(config.dbPath, config.profile, log);
    state = new SessionState();
    return true;
  }

  function flushState(): void {
    if (!client || !state) return;
    const spans = state.drainCompleted();
    for (const span of spans) {
      client.push(span);
    }
  }

  // ===== Session 事件 =====

  pi.on("session_start", (event, ctx) => {
    if (!ensureInitialized(ctx)) return;

    // 生成 session ID（同一 session 的所有 span 共享）
    sessionId = generateInstanceId();
    state!.startSession(sessionId);
    flushState();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!client || !state) return;
    // reload 时不 finalize root span，让重载实例继续同一 trace
    if (event.reason !== "reload") {
      state.finalize();
    }
    flushState();
    await client.forceFlush();
    if (event.reason !== "reload") {
      await client.shutdown();
      client = null;
      state = null;
      sessionId = null;
    }
  });

  // ===== Turn 事件 =====

  pi.on("before_agent_start", (event, ctx) => {
    if (!state?.isStarted()) return;
    state.startTurn(event.prompt);
    flushState();
  });

  pi.on("agent_end", (event, ctx) => {
    if (!state?.isStarted()) return;
    // willRetry=true 表示 agent 会重试，不结束 turn
    const willRetry = (event as { willRetry?: boolean }).willRetry;
    if (willRetry) return;
    state.finishTurn();
    flushState();
  });

  // ===== Message 事件（LLM 调用）=====

  pi.on("message_start", (event, ctx) => {
    if (!state?.isStarted()) return;
    state.recordLlmStart();
  });

  pi.on("message_end", (event, ctx) => {
    if (!state?.isStarted()) return;
    state.recordLlmEnd(event.message as unknown as AssistantMessage);
    flushState();
  });

  // ===== Tool 事件 =====

  pi.on("tool_execution_start", (event, ctx) => {
    if (!state?.isStarted()) return;
    state.recordToolStart(event.toolCallId, event.toolName);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!state?.isStarted()) return;
    state.recordToolEnd(
      event.toolCallId,
      event.toolName,
      event.result,
      event.isError,
    );
    flushState();
  });

  // ===== Compaction 事件 =====

  pi.on("session_before_compact", (event, ctx) => {
    if (!state?.isStarted()) return;
    state.startCompaction(event.reason);
  });

  pi.on("session_compact", (event, ctx) => {
    if (!state?.isStarted()) return;
    state.finishCompaction();
    flushState();
  });

  // ===== Branch 事件 =====

  pi.on("session_before_tree", (event, ctx) => {
    if (!state?.isStarted()) return;
    state.startBranch();
  });

  pi.on("session_tree", (event, ctx) => {
    if (!state?.isStarted()) return;
    state.finishBranch(event.newLeafId ?? "", event.oldLeafId ?? "");
    flushState();
  });
}
