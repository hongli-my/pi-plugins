import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OtelViewerConfig } from "./types.ts";

const EXTENSION_NAME = "otel-viewer";

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function loadConfig(cwd: string): OtelViewerConfig {
  const defaults: OtelViewerConfig = {
    // 与 opencode 插件分库：pi 写自己的 otel.db，Slate 读两个库合并展示
    dbPath: join(homedir(), ".local", "share", "pi", "otel.db"),
    enabled: true,
    profile: "default",
  };

  // 全局配置：~/.pi/agent/otel-viewer.json
  const globalPath = join(homedir(), ".pi", "agent", `${EXTENSION_NAME}.json`);
  const globalCfg = readJsonFile(globalPath) ?? {};

  // 项目配置：<cwd>/.pi/otel-viewer.json
  const projectPath = join(cwd, ".pi", `${EXTENSION_NAME}.json`);
  const projectCfg = readJsonFile(projectPath) ?? {};

  // 合并优先级：defaults → 全局 → 项目
  const merged: OtelViewerConfig = {
    dbPath:
      (projectCfg.dbPath as string) ??
      (globalCfg.dbPath as string) ??
      defaults.dbPath,
    enabled:
      (projectCfg.enabled as boolean) ??
      (globalCfg.enabled as boolean) ??
      defaults.enabled,
    profile:
      (projectCfg.profile as string) ??
      (globalCfg.profile as string) ??
      defaults.profile,
  };

  // 环境变量覆盖
  if (process.env.PI_OTEL_VIEWER_DB_PATH) {
    merged.dbPath = process.env.PI_OTEL_VIEWER_DB_PATH;
  }
  if (process.env.PI_OTEL_VIEWER_ENABLED) {
    merged.enabled = process.env.PI_OTEL_VIEWER_ENABLED === "true";
  }
  if (process.env.PI_OTEL_VIEWER_PROFILE) {
    merged.profile = process.env.PI_OTEL_VIEWER_PROFILE;
  }

  return merged;
}
