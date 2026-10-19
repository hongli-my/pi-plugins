# Session Manager Extension for Pi

Lightweight session management for the pi coding agent.

## Features

### `/sessions` — List, Switch, and Delete Sessions

A single interactive picker that lets you:

- **List** all sessions for the current project (name, first-message preview, last-modified time)
- **Switch** to a session — press `Enter`
- **Delete** a session — press `Ctrl+D` twice (double-press is the confirmation)
- Cancel — press `Esc` or `q`

The current session is marked `(current)` and cannot be deleted from within the picker.

## Installation

The extension lives at:

```
~/.pi/agent/extensions/session-manager/index.ts
```

Restart pi or run `/reload` to load it. The `/sessions` command will then be available.

## Usage

```
/sessions
```

| Key | Action |
| --- | --- |
| `↑` / `↓` or `k` / `j` | Navigate (wraps around) |
| `Enter` | Switch to the selected session |
| `Ctrl+D` then `Ctrl+D` | Delete the selected session |
| `Esc` / `q` / `Ctrl+C` | Close the picker |

### Deleting

1. Highlight a session.
2. Press `Ctrl+D` once — the status line shows `Press Ctrl+D again to delete: <name>` (auto-resets after 3s).
3. Press `Ctrl+D` again to confirm.

The current session cannot be deleted from the picker; select another first.

## Technical Details

- Session discovery uses `SessionManager.list(cwd)` (primary), with a direct `~/.pi/agent/sessions` directory scan as a fallback. The fallback matches pi's encoded directory name exactly (`--<cwd with / \ : replaced by ->--`); a substring match would also hit sibling checkouts like `.../starrocks-fe`.
- The extension never writes to stdout/stderr — pi's TUI only manages stdout, so `console.*` output corrupts the rendered frame. Set `PI_SESSION_MANAGER_DEBUG=1` to log to `~/.pi/agent/session-manager-debug.log` instead.
- Each session file (JSONL) is parsed to extract the display name, first user message, and entry count.
- Switching is performed via `ctx.switchSession()`.
- The picker is a custom TUI component built with `ctx.ui.custom()`.
- Deletion uses `node:fs/promises` `unlink()`. The double `Ctrl+D` press acts as the confirmation, so no extra dialog is shown.

## Customization

Edit the extension directly:

```
~/.pi/agent/extensions/session-manager/index.ts
```

After changes, run `/reload` to apply them.

## License

MIT
