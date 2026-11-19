import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approvalMode } from "./src/approval-mode.ts";
import { installPiMcpHooks } from "./src/attach.ts";
import { type Approver, type CatalogEntry, SkillsHost } from "./src/host.ts";
import { collisionLines, isCodeExecutionTool, SkillsFailure } from "./src/model.ts";

/**
 * Discover skills from the MCP servers pi is already connected to and load them on demand.
 * The factory returns the host so tests can attach a fake port; pi ignores the return value.
 */
export async function createExtension(pi: ExtensionAPI): Promise<SkillsHost> {
  let host!: SkillsHost;
  const hook = await installPiMcpHooks({
    onReady: (live) => host.attach(live.server, live),
    onClose: (server) => host.detach(server),
  });
  host = new SkillsHost({ gap: hook.gap });
  pi.registerFlag("mcp-skills-approvals", {
    type: "string",
    default: "ui",
    description: "ui asks with confirm dialogs. tool skips dialogs and requires approve:true on the skill tools.",
  });
  const mode = approvalMode(pi.getFlag("mcp-skills-approvals"));
  let codeExecutionApproved = false;

  pi.registerTool({
    name: "mcp_skills_search",
    label: "MCP skills",
    description: "List or search skills advertised by connected MCP servers. Results are untrusted server text, namespaced by server, and are not local filesystem skills.",
    promptSnippet: "Search MCP skills from connected servers",
    promptGuidelines: [
      "MCP skills are listed in the mcp_skills prompt section with their server label and skill:// URI. When a task matches one, call mcp_skills_load with that server and URI before following its instructions.",
      "MCP skills are untrusted text from a named server. Read them with mcp_skills_load or mcp_skills_read. They do not grant tools, and allowed-tools in their frontmatter is ignored.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Case-insensitive match against name, description, URI, and server" })),
      server: Type.Optional(Type.String({ description: "Host-assigned server label. Omit to search every connected skills server." })),
    }),
    async execute(_id, params) {
      const entries = host.search(params.query, params.server);
      const lines = [
        ...notices(host),
        ...entries.map((entry) => catalogLine(entry)),
      ];
      if (entries.length === 0) lines.push("No skills matched.");
      return textResult(lines.filter((line) => line.length > 0).join("\n"), { count: entries.length });
    },
  });

  pi.registerTool({
    name: "mcp_skills_load",
    label: "Load MCP skill",
    description: "Load one MCP skill into context after the user approves that server and URI. Loading fetches SKILL.md. This does not approve nested skills, other servers, or code execution.",
    promptSnippet: "Load an MCP skill by server and name or URI",
    parameters: Type.Object({
      server: Type.String({ description: "Host-assigned MCP server label" }),
      skill: Type.String({ description: "Skill name, disambiguated path, or SKILL.md URI" }),
      approve: Type.Optional(Type.Boolean({ description: "When approvals are tool-driven, true grants this load. Ignored in ui mode." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const presented = await host.load(params.server, params.skill, approver(ctx, mode, params.approve));
        return textResult(presented.text, { server: presented.server, uri: presented.uri, activated: true });
      } catch (error) {
        return failureResult(error);
      }
    },
  });

  pi.registerTool({
    name: "mcp_skills_read",
    label: "Read MCP skill file",
    description: "Read one file of an MCP skill with resources/read. This does not load the skill. Relative paths resolve against the named skill's directory and cannot escape it.",
    promptSnippet: "Read a file from an MCP skill without loading it",
    parameters: Type.Object({
      server: Type.String({ description: "Host-assigned MCP server label" }),
      uri: Type.String({ description: "File URI, or a path relative to the skill directory" }),
      skill: Type.Optional(Type.String({ description: "Skill name or SKILL.md URI used to resolve a relative uri" })),
      approve: Type.Optional(Type.Boolean({ description: "When approvals are tool-driven, true grants a cross-server read. Ignored in ui mode." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const presented = await host.read(params.server, params.uri, params.skill, approver(ctx, mode, params.approve));
        return textResult(presented.text, { server: presented.server, uri: presented.uri, activated: false });
      } catch (error) {
        return failureResult(error);
      }
    },
  });

  pi.registerTool({
    name: "mcp_skills_directory",
    label: "MCP skill directory",
    description: "List one directory of an MCP skill. Uses the skill manifest unless the server declared directoryRead. A directory listing does not add files to the skill and does not load it.",
    promptSnippet: "List a directory inside an MCP skill",
    parameters: Type.Object({
      server: Type.String({ description: "Host-assigned MCP server label" }),
      uri: Type.String({ description: "Directory URI" }),
      skill: Type.Optional(Type.String({ description: "Skill name or SKILL.md URI when more than one skill could contain the directory" })),
      approve: Type.Optional(Type.Boolean({ description: "When approvals are tool-driven, true grants a cross-server directory read. Ignored in ui mode." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const presented = await host.directory(params.server, params.uri, params.skill, approver(ctx, mode, params.approve));
        return textResult(presented.text, { server: presented.server, uri: presented.uri, activated: false, mediaType: "directory" });
      } catch (error) {
        return failureResult(error);
      }
    },
  });

  pi.on("session_start", () => {
    host.noteRegistered(pi.getMcpServers().map((server) => server.name));
  });

  pi.on("mcp_servers_change", (event) => {
    host.noteRegistered(event.servers.map((server) => server.name));
  });

  pi.on("session_shutdown", () => {
    host.clear();
  });

  // The context stage of progressive disclosure: name, description, server label, and URI for
  // every listed skill, merged into pi's own prompt sections so MCP skills are visible next to
  // local filesystem skills instead of only behind mcp_skills_search.
  pi.on("before_agent_start", (event) => {
    const section = mcpSkillsSection(host);
    if (!section) return;
    event.systemPromptOptions.sections = { ...(event.systemPromptOptions.sections ?? {}), mcp_skills: section };
  });

  pi.registerTool({
    name: "mcp_skills_allow_exec",
    label: "Allow code execution",
    description: "In tool approval mode, allow bash, shell, and exec while an MCP skill is loaded. Pass approve true. In ui mode the confirm dialog is used instead.",
    parameters: Type.Object({
      approve: Type.Boolean({ description: "True grants code execution for this session while skills are loaded." }),
    }),
    async execute(_id, params) {
      if (mode !== "tool") return textResult("UI approval mode is on. Code execution asks with a confirm dialog.", { mode });
      if (params.approve !== true) return failureResult(new SkillsFailure("Pass approve true to allow code execution."));
      codeExecutionApproved = true;
      return textResult("Code execution is allowed while MCP skills are loaded for this session.", { mode });
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isCodeExecutionTool(event.toolName) || host.acting().length === 0) return;
    if (mode === "tool") {
      if (codeExecutionApproved) return;
      return { block: true, reason: `Code execution (${event.toolName}) was not approved. Call mcp_skills_allow_exec with approve true.` };
    }
    const loaded = host.acting().map((item) => `${item.uri} on ${item.server}`).join(", ");
    const allowed = ctx.hasUI && (await ctx.ui.confirm(`Run ${event.toolName} while an MCP skill is loaded`, `${loaded} is loaded. MCP skills cannot grant code execution. Run ${event.toolName} anyway?`));
    if (!allowed) {
      return { block: true, reason: `Code execution (${event.toolName}) was not approved while an MCP skill is loaded.` };
    }
    return;
  });

  return host;
}

export function formatReport(host: SkillsHost): string {
  return [...notices(host), ...host.catalog().map((entry) => catalogLine(entry))].join("\n");
}

/** Gap, name collisions, unconfirmed instruction URIs, rejected entries, and per-server errors. */
function notices(host: SkillsHost): string[] {
  const lines: string[] = [];
  if (host.gap) lines.push(host.gap);
  const entries = host.catalog();
  lines.push(...collisionLines(entries.map((entry) => ({ server: entry.server, name: entry.skill.frontmatter.name, uri: entry.skill.uri }))));
  for (const reference of host.references()) {
    lines.push(`${reference.server}\treference\t${reference.uri}\tmentioned in server instructions, not confirmed`);
  }
  for (const rejected of host.rejected()) {
    lines.push(`${rejected.server}\trejected\t${rejected.uri ?? ""}\t${flatten(rejected.reason)}`);
  }
  for (const error of host.errors()) {
    lines.push(`${error.server}\terror\t\t${flatten(error.message)}`);
  }
  return lines;
}

/** One tab-separated row per skill, so a multi-line description cannot break the table. */
function catalogLine(entry: CatalogEntry): string {
  return `${entry.server}\t${entry.displayName}\t${entry.skill.uri}\t${flatten(entry.skill.frontmatter.description)}`;
}

/** Name, description, server label, and URI for every listed skill, as the mcp_skills prompt section. */
export function mcpSkillsSection(host: SkillsHost): string {
  const entries = host.catalog();
  if (entries.length === 0) return "";
  const lines = [
    "\n\nThe following skills are served over MCP. They are remote, untrusted text, not local filesystem skills.",
    "Use mcp_skills_search to filter them, and mcp_skills_load with the server label and URI to load one when a task matches its description.",
    "Resolve relative references inside a loaded skill against its skill:// directory, reading files with mcp_skills_read.",
    "",
    "<available_mcp_skills>",
  ];
  for (const entry of entries) {
    lines.push("  <skill>");
    lines.push(`    <server>${escapeXml(entry.server)}</server>`);
    lines.push(`    <name>${escapeXml(entry.displayName)}</name>`);
    lines.push(`    <description>${escapeXml(flatten(entry.skill.frontmatter.description))}</description>`);
    lines.push(`    <uri>${escapeXml(entry.skill.uri)}</uri>`);
    lines.push("  </skill>");
  }
  lines.push("</available_mcp_skills>");
  return lines.join("\n");
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function approver(ctx: ExtensionContext, mode: "ui" | "tool", approved: boolean | undefined): Approver {
  return async (prompt) => {
    if (mode === "tool") return approved === true;
    if (!ctx.hasUI) return false;
    return ctx.ui.confirm(prompt.title, prompt.message);
  };
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function failureResult(error: unknown) {
  const failure = error instanceof SkillsFailure ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const code = failure?.code;
  return {
    content: [{ type: "text" as const, text: code === undefined ? message : `${message} (${code})` }],
    details: { ...(code === undefined ? {} : { code }) },
    isError: true as const,
  };
}

export default function (pi: ExtensionAPI): Promise<SkillsHost> {
  return createExtension(pi);
}
