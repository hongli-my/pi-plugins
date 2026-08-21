// ===== Span 输出格式（与 otel-viewer 后端 /otel/api/ingest 兼容）=====

export interface SpanJson {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  status: { code: string; message?: string };
  session_id: string;
}

// ===== 配置 =====

export interface OtelViewerConfig {
  dbPath: string;
  enabled: boolean;
  profile: string;
}

// ===== pi 事件 payload 类型（宽松，pi 运行时可能附加未声明字段）=====

export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: unknown[];
  systemPrompt?: string;
  systemPromptOptions?: unknown;
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: unknown[];
  willRetry?: boolean;
}

export interface MessageStartEvent {
  type: "message_start";
  message: AssistantMessage;
}

export interface MessageEndEvent {
  type: "message_end";
  message: AssistantMessage;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  reason: string;
  willRetry?: boolean;
}

export interface SessionCompactEvent {
  type: "session_compact";
  reason: string;
  willRetry?: boolean;
}

export interface SessionBeforeTreeEvent {
  type: "session_before_tree";
}

export interface SessionTreeEvent {
  type: "session_tree";
  newLeafId: string;
  oldLeafId: string;
}

// ===== AssistantMessage（从 pi-agent-core 推断，字段可选）=====

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: {
    input?: number;
    output?: number;
    total?: number;
  };
}

export interface AssistantMessage {
  role?: string;
  content?: ContentBlock[];
  usage?: Usage;
  provider?: string;
  model?: string;
  stopReason?: string;
  timestamp?: string;
  responseId?: string;
  api?: string;
  errorMessage?: string;
}

export interface ContentBlock {
  type: string;
  // TextContent
  text?: string;
  // ThinkingContent
  thinking?: string;
  // ToolCall (pi-ai): type="toolCall", id, name, arguments
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  // 兼容旧字段（不再使用）
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}
