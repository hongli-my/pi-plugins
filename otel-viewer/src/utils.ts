// 生成 32 字符 hex traceId（OTel 格式）
export function generateTraceId(): string {
  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (id) return id.replace(/-/g, "").padEnd(32, "0");
  } catch {
    // 回退
  }
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

// 生成 16 字符 hex spanId（OTel 格式）
export function generateSpanId(): string {
  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (id) return id.replace(/-/g, "").slice(0, 16);
  } catch {
    // 回退
  }
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

// 生成 8 字符进程级实例 ID（启动时调用一次）
export function generateInstanceId(): string {
  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (id) return id.replace(/-/g, "").slice(0, 8);
  } catch {
    // 回退
  }
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

export function nowMs(): number {
  return Date.now();
}

// 截断大字符串，避免 span 属性过大
export function truncate(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...(truncated)";
}
