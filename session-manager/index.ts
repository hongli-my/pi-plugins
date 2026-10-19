/**
 * Session Manager Extension for Pi
 *
 * Features:
 * - /sessions - List sessions, switch to selected, or delete with Ctrl+D x2
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { stat, readdir, readFile, unlink, appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const DEBUG_LOG = join(homedir(), ".pi", "agent", "session-manager-debug.log");

/**
 * Debug output must never go to stdout/stderr: pi's TUI only manages stdout, so
 * a stray console.* call paints over the rendered frame and leaves junk at the
 * bottom of the screen. Log to a file instead, and only when asked to.
 */
function debugLog(...args: unknown[]): void {
  if (process.env.PI_SESSION_MANAGER_DEBUG !== "1") return;
  const line = args
    .map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  void appendFile(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`).catch(() => {});
}

interface SessionInfo {
  file: string;
  name?: string;
  firstMessage?: string;
  messageCount: number;
  lastModified: Date;
  size: number;
}

interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export default function sessionManagerExtension(pi: ExtensionAPI) {
  /**
   * /sessions - List, switch, and delete sessions
   */
  pi.registerCommand("sessions", {
    description: "List sessions, switch to selected, or delete with Ctrl+D x2",
    handler: async (args, ctx) => {
      try {
        const cwd = ctx.cwd;
        if (!cwd) {
          ctx.ui.notify("No working directory", "error");
          return;
        }

        const sessionInfos = await getSessionInfos(cwd);

        if (sessionInfos.length === 0) {
          ctx.ui.notify("No sessions found for this project", "info");
          return;
        }

        // Sort by last modified (newest first)
        sessionInfos.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

        const currentFile = ctx.sessionManager.getSessionFile();
        const theme = ctx.ui.theme;

        const selectedFile = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
          const picker = new SessionPicker({
            items: sessionInfos,
            currentFile: currentFile ?? undefined,
            theme,
            ctx,
            onDone: done,
            requestRender: () => tui.requestRender(),
          });
          picker.attachTui(tui);
          return picker;
        });

        if (selectedFile === null) return; // User cancelled

        // Switch directly - no extra confirmation
        const session = sessionInfos.find(s => s.file === selectedFile);
        if (!session) return;

        // Don't switch if it's already the current session
        if (session.file === currentFile) {
          ctx.ui.notify("Already in this session", "info");
          return;
        }

        const sessionName = session.name || labelFromFile(session.file);
        await ctx.switchSession(session.file, {
          withSession: async (ctx) => {
            ctx.ui.notify(`Switched to: ${sessionName}`, "info");
          }
        });

      } catch (error) {
        debugLog('[session-manager] Error in /sessions:', error);
        ctx.ui.notify(`Error: ${error}`, "error");
      }
    },
  });
}

/**
 * Custom session picker component with inline status and Ctrl+D delete
 */
class SessionPicker {
  private items: SelectItem[];
  private sessionInfos: SessionInfo[];
  private currentFile?: string;
  private theme: any;
  private ctx: any;
  private onDone: (result: string | null) => void;
  private requestRenderFn: () => void;
  private tui: any;
  private selectedIndex: number = 0;
  private statusMessage: string = "";
  private ctrlDPressedOnce: boolean = false;
  private ctrlDTimer: NodeJS.Timeout | null = null;
  private disposed: boolean = false;

  constructor(opts: {
    items: SessionInfo[];
    currentFile?: string;
    theme: any;
    ctx: any;
    onDone: (result: string | null) => void;
    requestRender: () => void;
  }) {
    this.sessionInfos = opts.items;
    this.currentFile = opts.currentFile;
    this.theme = opts.theme;
    this.ctx = opts.ctx;
    this.onDone = opts.onDone;
    this.requestRenderFn = opts.requestRender;
    this.items = this.buildItems();
  }

  attachTui(tui: any): void {
    this.tui = tui;
  }

  dispose(): void {
    this.disposed = true;
    if (this.ctrlDTimer) {
      clearTimeout(this.ctrlDTimer);
      this.ctrlDTimer = null;
    }
  }

  private buildItems(): SelectItem[] {
    return this.sessionInfos.map((s) => {
      // Flatten the name too: a user-set session name may contain newlines/
      // control characters, which would break the row layout the same way raw
      // previews used to. Cap long names so the preview/date stay visible.
      const name = s.name ? truncate(flattenText(s.name), 28) : labelFromFile(s.file);
      const isCurrent = s.file === this.currentFile;
      const flattened = s.firstMessage ? flattenText(s.firstMessage) : "";
      const preview = flattened ? truncate(flattened, 45) : "(no messages)";
      const date = formatDate(s.lastModified);
      return {
        value: s.file,
        label: isCurrent ? `${name} (current)` : name,
        description: `${preview} | ${date}`,
      };
    });
  }

  handleInput(data: string): void {
    // Ctrl+C is pi's cancel key. Handle it here too, otherwise the only exits
    // (Esc / q) are non-obvious and an empty list looks like a stuck dialog.
    if (matchesKey(data, Key.ctrl("c"))) {
      this.onDone(null);
      return;
    }

    // Handle Ctrl+D for delete (double-press)
    if (matchesKey(data, Key.ctrl("d"))) {
      this.handleCtrlD();
      this.requestRender();
      return;
    }

    // Reset Ctrl+D state on any other key
    if (this.ctrlDPressedOnce) {
      this.ctrlDPressedOnce = false;
      this.statusMessage = "";
      if (this.ctrlDTimer) {
        clearTimeout(this.ctrlDTimer);
        this.ctrlDTimer = null;
      }
    }

    // Up
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
      } else {
        this.selectedIndex = this.items.length - 1; // wrap
      }
      this.requestRender();
      return;
    }

    // Down
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (this.selectedIndex < this.items.length - 1) {
        this.selectedIndex++;
      } else {
        this.selectedIndex = 0; // wrap
      }
      this.requestRender();
      return;
    }

    // Enter - select
    if (matchesKey(data, Key.enter)) {
      const item = this.items[this.selectedIndex];
      this.onDone(item ? item.value : null);
      return;
    }

    // Escape / q - cancel
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.onDone(null);
      return;
    }
  }

  private handleCtrlD() {
    if (this.ctrlDPressedOnce) {
      // Second Ctrl+D - perform delete
      this.ctrlDPressedOnce = false;
      if (this.ctrlDTimer) {
        clearTimeout(this.ctrlDTimer);
        this.ctrlDTimer = null;
      }

      const item = this.items[this.selectedIndex];
      if (!item) {
        this.statusMessage = "No session selected";
        return;
      }

      // Don't allow deleting current session
      if (item.value === this.currentFile) {
        this.statusMessage = "⚠ Cannot delete the current session";
        this.ctx.ui.notify("Cannot delete the current session", "warning");
        return;
      }

      // Delete directly - double Ctrl+D is the confirmation
      this.statusMessage = `Deleting ${item.label}...`;
      unlink(item.value)
        .then(() => {
          this.ctx.ui.notify(`✓ Deleted: ${item.label}`, "info");

          // Stop here if the picker was closed during the async delete
          if (this.disposed) return;

          // Remove from lists
          const idx = this.sessionInfos.findIndex(s => s.file === item.value);
          if (idx >= 0) {
            this.sessionInfos.splice(idx, 1);
            this.items = this.buildItems();
            // Keep selection in range
            if (this.selectedIndex >= this.items.length) {
              this.selectedIndex = Math.max(0, this.items.length - 1);
            }
          }

          // Close if no sessions left
          if (this.items.length === 0) {
            this.onDone(null);
            return;
          }

          this.statusMessage = "";
          this.requestRender();
        })
        .catch((error) => {
          this.ctx.ui.notify(`Failed to delete: ${error}`, "error");
          if (this.disposed) return;
          this.statusMessage = `✗ Failed: ${error.message}`;
          this.requestRender();
        });
    } else {
      // First Ctrl+D - arm deletion
      const item = this.items[this.selectedIndex];
      if (!item) return;

      // Warn if trying to delete current session
      if (item.value === this.currentFile) {
        this.statusMessage = "⚠ Cannot delete the current session - select another";
        this.ctrlDTimer = setTimeout(() => {
          if (this.disposed) return;
          this.ctrlDPressedOnce = false;
          this.statusMessage = "";
          this.requestRender();
        }, 2500);
        return;
      }

      this.ctrlDPressedOnce = true;
      this.statusMessage = `Press Ctrl+D again to delete: ${item.label}`;
      this.ctrlDTimer = setTimeout(() => {
        if (this.disposed) return;
        this.ctrlDPressedOnce = false;
        this.statusMessage = "";
        this.requestRender();
      }, 3000);
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];

    // Header
    lines.push(truncateToWidth(theme.fg("accent", theme.bold("Select Session")), width));
    lines.push(truncateToWidth(
      theme.fg("dim", "↑↓ navigate • enter switch • Ctrl+D×2 delete • esc cancel"),
      width
    ));
    lines.push("");

    if (this.items.length === 0) {
      lines.push(truncateToWidth(theme.fg("dim", "  No sessions for this project"), width));
    } else {
      // Render items with selection highlight
      const maxVisible = 20;
      const half = Math.floor(maxVisible / 2);
      let start = Math.max(0, this.selectedIndex - half);
      const end = Math.min(this.items.length, start + maxVisible);
      if (end - start < maxVisible) {
        start = Math.max(0, end - maxVisible);
      }

      for (let i = start; i < end; i++) {
        const item = this.items[i];
        const isSelected = i === this.selectedIndex;
        const isCurrent = item.value === this.currentFile;
        const prefix = isSelected ? "▶ " : "  ";
        let line = prefix + item.label;
        if (item.description) {
          line += "  " + theme.fg("muted", item.description);
        }
        let styledLine: string;
        if (isSelected) {
          styledLine = theme.fg("accent", line);
        } else if (isCurrent) {
          styledLine = theme.fg("dim", line);
        } else {
          styledLine = line;
        }
        lines.push(truncateToWidth(styledLine, width));
      }

      // Scroll indicator
      if (this.items.length > maxVisible) {
        lines.push(truncateToWidth(
          theme.fg("dim", `  (${this.selectedIndex + 1}/${this.items.length})`),
          width
        ));
      }
    }

    // Status line (inline, not a notify popup)
    lines.push("");
    if (this.items.length === 0) {
      lines.push(truncateToWidth(
        theme.fg("dim", "Press Esc / q / Ctrl+C to close"),
        width
      ));
    } else if (this.statusMessage) {
      const color = this.statusMessage.startsWith("⚠") || this.statusMessage.startsWith("✗")
        ? "error"
        : this.statusMessage.startsWith("Press Ctrl+D")
        ? "warning"
        : "muted";
      lines.push(truncateToWidth(theme.fg(color, this.statusMessage), width));
    } else {
      lines.push(truncateToWidth(
        theme.fg("dim", "Tip: Ctrl+D twice deletes the selected session"),
        width
      ));
    }

    return lines;
  }

  invalidate(): void {
    // No cached state
  }

  private requestRender(): void {
    this.requestRenderFn();
  }
}

/**
 * Get session infos for a cwd
 */
async function getSessionInfos(cwd: string): Promise<SessionInfo[]> {
  const sessionInfos: SessionInfo[] = [];
  const seen = new Set<string>();

  const addInfo = (info: SessionInfo | null | undefined) => {
    if (!info) return;
    if (seen.has(info.file)) return;
    seen.add(info.file);
    sessionInfos.push(info);
  };

  // Method 1: SessionManager.list() — respects pi's session discovery rules,
  // but skips session files without a `session` header entry (e.g. resumed
  // or forked sessions), so it can miss real sessions.
  try {
    const result = await SessionManager.list(cwd);
    if (Array.isArray(result)) {
      const sessions = result.filter(s => s && typeof s.path === 'string');
      debugLog(`[session-manager] list() returned ${sessions.length} sessions`);

      for (const session of sessions) {
        try {
          addInfo(await getSessionInfo(session.path));
        } catch (error) {
          debugLog(`Failed to read ${session.path}:`, error);
        }
      }
    }
  } catch (error) {
    debugLog(`[session-manager] list() failed:`, error);
  }

  // Method 2: Direct read of the cwd session dir. Always runs so sessions
  // that list() skipped (no `session` header) still show up, deduped by path.
  try {
    const sessionsBaseDir = join(homedir(), '.pi', 'agent', 'sessions');
    const dirs = await readdir(sessionsBaseDir, { withFileTypes: true });

    // Match pi's default session dir naming exactly (see pi's
    // getDefaultSessionDirPath). A substring match is wrong: for
    // .../StarRocks/starrocks it also matches .../StarRocks/starrocks-fe,
    // and find() may return that unrelated (empty) directory.
    const expectedDirName = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const matchingDir = dirs.find(d =>
      (d.isDirectory() || d.isSymbolicLink()) &&
      d.name === expectedDirName
    );

    if (matchingDir) {
      const sessionDir = join(sessionsBaseDir, matchingDir.name);
      const files = await readdir(sessionDir);
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

      let directCount = 0;
      for (const file of jsonlFiles) {
        try {
          const info = await getSessionInfo(join(sessionDir, file));
          if (info) {
            addInfo(info);
            directCount++;
          }
        } catch (error) {
          debugLog(`Failed to read ${file}:`, error);
        }
      }

      debugLog(`[session-manager] Direct read found ${directCount} session files (${sessionInfos.length} unique)`);
    }
  } catch (error) {
    debugLog(`[session-manager] Direct read failed:`, error);
  }

  return sessionInfos;
}

/**
 * Get SessionInfo for a file
 */
async function getSessionInfo(filePath: string): Promise<SessionInfo | null> {
  const stats = await stat(filePath);
  const data = await readSessionFile(filePath);

  return {
    file: filePath,
    name: data.name,
    firstMessage: getFirstUserMessage(data),
    messageCount: data.entries?.length || 0,
    lastModified: stats.mtime,
    size: stats.size,
  };
}

/**
 * Read session file
 */
async function readSessionFile(filePath: string): Promise<any> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(l => l.trim());

  const entries: any[] = [];
  let name: string | undefined;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
      // pi stores user-defined display names in `session_info` entries.
      // The latest entry wins; an empty name clears the display name.
      if (entry.type === "session_info") {
        name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
      }
    } catch (e) {
      // Skip invalid lines
    }
  }

  return { name, entries };
}

/**
 * Get first user message
 */
function getFirstUserMessage(data: any): string | undefined {
  for (const entry of data.entries || []) {
    if (
      entry.type === "message" &&
      entry.message?.role === "user" &&
      entry.message?.content
    ) {
      const content = entry.message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const textPart = content.find((p: any) => p.type === "text");
        if (textPart) return textPart.text;
      }
    }
  }
  return undefined;
}

/**
 * Format date
 */
function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return date.toLocaleDateString();
}

/**
 * Truncate string
 */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/**
 * Flatten control characters (newlines, tabs, etc.) so a session preview is
 * always a single line. pi session files store raw user messages, which
 * may contain newlines; embedding them in a rendered line breaks the layout.
 * (Same approach as pi's own session selector.)
 */
function flattenText(str: string): string {
  return str.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Derive a human-readable label from pi's session filename
 * (e.g. "2026-08-21T09-15-54-579Z_01a0239a-....jsonl" -> "2026-08-21 09:15:54").
 * Falls back to the bare filename for other formats.
 */
function labelFromFile(file: string): string {
  const base = basename(file).replace(/\.jsonl$/, '');
  const m = base.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
  return base;
}
