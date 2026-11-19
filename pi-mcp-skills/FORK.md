# Local fork of pi-mcp-skills 0.1.0

Upstream: <https://github.com/richardanaya/pi-mcp-skills> (MIT, © Richard Anaya).
Source copied from `~/.pi/agent/npm/node_modules/pi-mcp-skills` (no upstream git access from this machine).

## Local changes

1. **`mcp_skills_search` no longer prints every skill twice.**
   `execute()` used to concat `formatReport(host)` (which already printed every catalog row) with
   the matching rows. Now `notices()` holds gap/collisions/references/rejected/errors and each row
   is printed once.
2. **Context stage of progressive disclosure.** New `before_agent_start` handler writes an
   `mcp_skills` system-prompt section listing `server`, `name`, `description`, and `uri` for every
   listed skill, mirroring pi's built-in `<available_skills>` shape. Without it the model could
   only discover MCP skills by guessing to call `mcp_skills_search`.
   (SEP-2640 "Hosts: End-to-End Integration" Registry/Context steps; not normative, but this is
   what makes MCP skills behave like filesystem skills.)
3. **Rows stay rows.** Descriptions, rejection reasons, and error messages are whitespace-flattened
   before printing, so a multi-line description cannot break the tab-separated table.
4. **Stronger tool guidance.** `mcp_skills_search.promptGuidelines` now tells the model where the
   list lives and to `mcp_skills_load` before following a skill.

## `node_modules` is symlinks, on purpose

`node_modules/{typebox,yaml,@earendil-works/*}` point at the global pi install. Same module
instances as the running `pi` process, which `src/attach.ts` needs in order to patch
`McpClient.connect` / `McpServerConnection`. Do not replace them with copies.
`pi-plugins/.gitignore` keeps `node_modules/` out of git; recreate the symlinks after a fresh clone.

## Loading

Registered in `../package.json` under `pi.extensions`. `npm:pi-mcp-skills` was removed from
`~/.pi/agent/settings.json` so the same tool names are not registered twice.

## Upstream issues worth reporting

- `index.ts` search/`formatReport` double print (fixed here).
- No Registry→Context injection: name/description never enter the system prompt.
- Unflattened multi-line descriptions in the row format.
