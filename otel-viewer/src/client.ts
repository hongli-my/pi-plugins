import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { SpanJson } from "./types.ts";
import { generateInstanceId } from "./utils.ts";

type LogLevel = "info" | "warn" | "error";

// 与 OpenResty/Slate/opencode-plugin 共享的 spans 表一行（20 业务列，对齐 db.lua SCHEMA_SQL）
interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  attributesJson: string | null;
  resourceJson: string | null;
  statusCode: string;
  statusMessage: string | null;
  sessionId: string | null;
  instanceId: string;
  profile: string | null;
  inputTokens: number;
  outputTokens: number;
  modelProvider: string | null;
  modelId: string | null;
  ingestedAt: number;
}

// ===== SQL（与 opencode-plugin-otel-viewer/src/index.ts、lua/lib/db.lua 完全一致）=====

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  attributes_json TEXT,
  resource_json TEXT,
  status_code TEXT,
  status_message TEXT,
  session_id TEXT,
  instance_id TEXT,
  profile TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  model_provider TEXT,
  model_id TEXT,
  ingested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spans_trace   ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id);
CREATE INDEX IF NOT EXISTS idx_spans_start   ON spans(start_ms);
CREATE INDEX IF NOT EXISTS idx_spans_name    ON spans(name);
`;

const INSERT_SQL = `
INSERT INTO spans (
  trace_id, span_id, parent_span_id, name, kind,
  start_ms, end_ms, duration_ms,
  attributes_json, resource_json, status_code, status_message,
  session_id, instance_id, profile,
  input_tokens, output_tokens, model_provider, model_id,
  ingested_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// trace 级 session_id 归一化：同一 trace 内多个 session_id 时取 span 数最多者
const NORMALIZE_SQL = `
UPDATE spans
   SET session_id = (
           SELECT s2.session_id FROM spans s2
           WHERE s2.trace_id = spans.trace_id
             AND s2.session_id IS NOT NULL AND s2.session_id <> ''
           GROUP BY s2.session_id
           ORDER BY COUNT(*) DESC, MIN(s2.start_ms) ASC
           LIMIT 1)
 WHERE session_id IS NOT NULL AND session_id <> ''
   AND trace_id = ?
   AND session_id <> (
           SELECT s2.session_id FROM spans s2
           WHERE s2.trace_id = spans.trace_id
             AND s2.session_id IS NOT NULL AND s2.session_id <> ''
           GROUP BY s2.session_id
           ORDER BY COUNT(*) DESC, MIN(s2.start_ms) ASC
           LIMIT 1)
`;

// 回填 session_id：子 span 无 session 元数据时从同 trace 父 span 继承
const BACKFILL_SQL = `
UPDATE spans
   SET session_id = (
           SELECT s2.session_id FROM spans s2
           WHERE s2.trace_id = spans.trace_id
             AND s2.session_id IS NOT NULL AND s2.session_id <> ''
           LIMIT 1)
 WHERE (session_id IS NULL OR session_id = '')
   AND trace_id = ?
   AND EXISTS (
           SELECT 1 FROM spans s2
           WHERE s2.trace_id = spans.trace_id
             AND s2.session_id IS NOT NULL AND s2.session_id <> '')
`;

// ===== 工具函数（对齐 opencode-plugin / db.lua）=====

// 对齐 Lua to_str：nil/undefined -> null；基本类型转字符串；对象 -> JSON
function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

// 对齐 Lua to_num：非数字 -> 0
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// 从 attributes 提取 session_id（对齐 db.lua:300-310）
// pi 的 state.ts 已在 attributes["session.id"] 注入 sessionId，通常走第一分支。
function extractSessionId(attrs: Record<string, unknown>): string | null {
  let sid = toStr(attrs["session.id"]);
  if (sid === null) {
    const headers = attrs["ai.request.headers"];
    if (headers && typeof headers === "object") {
      const h = headers as Record<string, unknown>;
      sid = toStr(h["X-Session-Id"]);
      if (sid === null) sid = toStr(h["x-session-affinity"]);
    }
  }
  if (sid === null) {
    const meta = attrs["ai.telemetry.metadata"];
    if (meta && typeof meta === "object") {
      sid = toStr((meta as Record<string, unknown>)["sessionId"]);
    }
  }
  return sid;
}

// SpanJson -> DB 行（对齐 opencode-plugin spanToRow，但输入是手构 SpanJson 而非 ReadableSpan）
function spanToRow(
  span: SpanJson,
  instanceId: string,
  profile: string,
  ingestedAt: number,
): SpanRow {
  const attrs = span.attributes ?? {};
  const resource = span.resource ?? {};

  const sessionId = extractSessionId(attrs) ?? span.session_id ?? null;
  // pi resource 无 service.instance.id，回退到 client 的进程级 instanceId
  const spanInstance = toStr(resource["service.instance.id"]) ?? instanceId;
  const inputTokens = toNum(attrs["gen_ai.usage.input_tokens"]) || toNum(attrs["ai.usage.inputTokens"]);
  const outputTokens = toNum(attrs["gen_ai.usage.output_tokens"]) || toNum(attrs["ai.usage.outputTokens"]);
  const modelProvider = toStr(attrs["gen_ai.system"]) ?? toStr(attrs["ai.model.provider"]);
  const modelId =
    toStr(attrs["gen_ai.request.model"]) ?? toStr(attrs["ai.model.id"]) ?? toStr(attrs["gen_ai.model"]);

  let attributesJson: string | null;
  try {
    attributesJson = JSON.stringify(attrs);
  } catch {
    attributesJson = null;
  }
  let resourceJson: string | null;
  try {
    resourceJson = JSON.stringify(resource);
  } catch {
    resourceJson = null;
  }

  const startMs = span.startMs;
  const endMs = span.endMs;
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    startMs,
    endMs,
    durationMs: span.durationMs || endMs - startMs,
    attributesJson,
    resourceJson,
    statusCode: span.status?.code ?? "OK",
    statusMessage: span.status?.message ?? null,
    sessionId,
    instanceId: spanInstance,
    profile,
    inputTokens,
    outputTokens,
    modelProvider,
    modelId,
    ingestedAt,
  };
}

// ===== SQLite 客户端：缓冲 + 批量事务写本地 SQLite =====

/**
 * 替代 HttpClient：直接写本地 SQLite（node:sqlite DatabaseSync）。
 * 保持 push/forceFlush/shutdown 接口，index.ts / state.ts 无需改动。
 *
 * pi 运行于 node（非 bun），故用 node:sqlite 而非 bun:sqlite。
 * node:sqlite 是 node 22 内置实验模块，零依赖，启动时打印 ExperimentalWarning（无害）。
 */
export class SqliteClient {
  private buffer: SpanRow[] = [];
  private pendingTraceIds = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  private readonly maxBuffer = 50;
  private readonly flushIntervalMs = 5000;

  private readonly instanceId: string;
  private readonly db: DatabaseSync;
  private readonly insertStmt: ReturnType<DatabaseSync["prepare"]>;
  private readonly normalizeStmt: ReturnType<DatabaseSync["prepare"]>;
  private readonly backfillStmt: ReturnType<DatabaseSync["prepare"]>;

  constructor(
    private readonly dbPath: string,
    private readonly profile: string,
    private readonly log: (level: LogLevel, msg: string) => void,
  ) {
    this.instanceId = generateInstanceId();

    // 确保目录存在（首次运行 / 全新机器）
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      // 目录已存在或无权限：打开 db 时会再报错
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec(SCHEMA_SQL);

    this.insertStmt = this.db.prepare(INSERT_SQL);
    this.normalizeStmt = this.db.prepare(NORMALIZE_SQL);
    this.backfillStmt = this.db.prepare(BACKFILL_SQL);

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // 定时器不阻止进程退出
    if (this.flushTimer && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  push(span: SpanJson): void {
    try {
      const row = spanToRow(span, this.instanceId, this.profile, Date.now());
      this.buffer.push(row);
      if (row.traceId) this.pendingTraceIds.add(row.traceId);
      if (this.buffer.length >= this.maxBuffer) {
        void this.flush();
      }
    } catch (err) {
      this.log("error", `push 转换失败: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  async forceFlush(): Promise<void> {
    await this.flush();
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flush();
    } catch {
      // flush 内部已记录错误
    }
    try {
      this.db.close();
    } catch {
      // 关闭失败不影响进程退出
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    const traceIds = [...this.pendingTraceIds];
    this.buffer = [];
    this.pendingTraceIds = new Set();
    this.flushing = true;
    try {
      this.flushTx(rows, traceIds);
    } catch (err) {
      this.log(
        "error",
        `flush 写入失败，丢弃 ${rows.length} 条 span: ${(err as Error)?.message ?? String(err)}`,
      );
    } finally {
      this.flushing = false;
    }
  }

  // node:sqlite 无 transaction() 包装，手动 BEGIN/COMMIT/ROLLBACK
  private flushTx(rows: SpanRow[], traceIds: string[]): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const r of rows) {
        this.insertStmt.run(
          r.traceId,
          r.spanId,
          r.parentSpanId,
          r.name,
          r.kind,
          r.startMs,
          r.endMs,
          r.durationMs,
          r.attributesJson,
          r.resourceJson,
          r.statusCode,
          r.statusMessage,
          r.sessionId,
          r.instanceId,
          r.profile,
          r.inputTokens,
          r.outputTokens,
          r.modelProvider,
          r.modelId,
          r.ingestedAt,
        );
      }
      for (const tid of traceIds) {
        this.normalizeStmt.run(tid);
        this.backfillStmt.run(tid);
      }
      this.db.exec("COMMIT;");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // 回滚失败忽略
      }
      throw err;
    }
  }
}
