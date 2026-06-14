/** Frontend-independent control-plane slash command router. */

import type { DiagnosticsProjector } from "./admin-server.js";
import type { SessionRecord } from "../sessions/types.js";

export type SlashCommandName = "help" | "status" | "session" | "new" | "reload-mcp";

export interface SlashCommandResetResult {
  readonly oldSessionId: string;
  readonly newSessionId: string;
  readonly oldInstanceId: string | null;
  readonly newInstanceId: string | null;
  readonly archivedMessageCount: number;
  readonly resetAt: string;
}

export interface SlashCommandResetRequest {
  readonly sessionId: string;
  readonly requestedBy: string;
  readonly reason: string;
}

export interface SlashCommandMcpReloadRequest {
  readonly sessionId: string;
  readonly profileId: string;
  readonly requestedBy: string;
  readonly reason: string;
}

export interface SlashCommandMcpReloadResult {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly profileId: string;
  readonly endpoint: string;
  readonly oldToolNames: readonly string[];
  readonly newToolNames: readonly string[];
  readonly addedToolNames: readonly string[];
  readonly removedToolNames: readonly string[];
  readonly durationMs: number;
  readonly serverCount: number;
  readonly reloadedAt: string;
  readonly error?: string;
}

export interface SlashCommandRouterDeps {
  readonly diagnostics: DiagnosticsProjector;
  readonly resetSession?: (request: SlashCommandResetRequest) => Promise<SlashCommandResetResult>;
  readonly reloadMcp?: (request: SlashCommandMcpReloadRequest) => Promise<SlashCommandMcpReloadResult>;
  readonly now?: () => Date;
}

export interface SlashCommandRequest {
  readonly session: SessionRecord;
  readonly input: string;
  readonly requestedBy?: string;
}

export type SlashCommandResult =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly command: SlashCommandName;
      readonly ok: boolean;
      readonly message: string;
      readonly evidence: Readonly<Record<string, unknown>>;
    };

export interface SlashCommandRouter {
  tryHandle(request: SlashCommandRequest): Promise<SlashCommandResult>;
}

interface ParsedSlashCommand {
  readonly command: SlashCommandName;
  readonly argument: string;
}

export function createSlashCommandRouter(deps: SlashCommandRouterDeps): SlashCommandRouter {
  return new DefaultSlashCommandRouter(deps);
}

class DefaultSlashCommandRouter implements SlashCommandRouter {
  readonly #diagnostics: DiagnosticsProjector;
  readonly #resetSession?: (request: SlashCommandResetRequest) => Promise<SlashCommandResetResult>;
  readonly #reloadMcp?: (request: SlashCommandMcpReloadRequest) => Promise<SlashCommandMcpReloadResult>;
  readonly #now: () => Date;

  constructor(deps: SlashCommandRouterDeps) {
    this.#diagnostics = deps.diagnostics;
    this.#resetSession = deps.resetSession;
    this.#reloadMcp = deps.reloadMcp;
    this.#now = deps.now ?? (() => new Date());
  }

  async tryHandle(request: SlashCommandRequest): Promise<SlashCommandResult> {
    const parsed = parseSlashCommand(request.input);
    if (parsed === null) return { handled: false };
    if (request.session.kind !== "full") {
      return handled(
        parsed.command,
        false,
        "Slash commands are only available for full-agent sessions.",
        {
          sessionId: request.session.id,
          kind: request.session.kind,
        },
      );
    }
    if (parsed.command === "help") return this.#help();
    if (parsed.command === "status" || parsed.command === "session")
      return this.#status(request.session, parsed.command);
    if (parsed.command === "reload-mcp") return this.#reloadMcpCommand(request, parsed.argument);
    return this.#newSession(request, parsed.argument);
  }

  #help(): SlashCommandResult {
    return handled(
      "help",
      true,
      [
        "Control-plane commands are intercepted before LLM prompting:",
        "- /help — list commands",
        "- /status or /session — show current session diagnostics",
        "- /new [reason] — request a session reset boundary",
        "- /reload-mcp [reason] — reload MCP/tool surface without resetting the session",
      ].join("\n"),
      { commandSurface: "control-plane" },
    );
  }

  async #status(
    session: SessionRecord,
    command: "status" | "session",
  ): Promise<SlashCommandResult> {
    const overview = await this.#diagnostics.projectOverview();
    const projected = overview.sessions.find((item) => item.sessionId === session.id);
    return handled(
      command,
      true,
      [
        `sessionId: ${session.id}`,
        `profileId: ${session.profileId}`,
        `state: ${session.state}`,
        `instanceId: ${session.instanceId ?? "none"}`,
        `channelBindings: ${session.channelBindings.length}`,
        `presence: ${projected?.presenceStatus ?? "unknown"}`,
        `classification: ${projected?.classification ?? "unknown"}`,
        `recentErrorCount: ${String(projected?.recentErrorCount ?? 0)}`,
      ].join("\n"),
      {
        sessionId: session.id,
        profileId: session.profileId,
        projected: projected !== undefined,
      },
    );
  }

  async #reloadMcpCommand(request: SlashCommandRequest, reason: string): Promise<SlashCommandResult> {
    const normalizedReason = reason.trim().length > 0 ? reason.trim() : "manual_reload";
    const requestedBy = request.requestedBy ?? "unknown";
    if (this.#reloadMcp === undefined) {
      return handled(
        "reload-mcp",
        false,
        "MCP reload was recognized as a control-plane command, but the tool-surface reload handler is not wired for this frontend.",
        {
          sessionId: request.session.id,
          profileId: request.session.profileId,
          requestedBy,
          reason: normalizedReason,
          missingSeam: "mcp_tool_surface_reload_handler",
        },
      );
    }
    const reload = await this.#reloadMcp({
      sessionId: request.session.id,
      profileId: request.session.profileId,
      requestedBy,
      reason: normalizedReason,
    });
    return handled(
      "reload-mcp",
      reload.ok,
      [
        reload.ok ? "MCP tool surface reload complete." : "MCP tool surface reload failed.",
        `sessionId: ${reload.sessionId}`,
        `profileId: ${reload.profileId}`,
        `endpoint: ${reload.endpoint}`,
        `oldToolCount: ${String(reload.oldToolNames.length)}`,
        `newToolCount: ${String(reload.newToolNames.length)}`,
        `added: ${reload.addedToolNames.join(", ") || "none"}`,
        `removed: ${reload.removedToolNames.join(", ") || "none"}`,
        `durationMs: ${String(reload.durationMs)}`,
        ...(reload.error === undefined ? [] : [`error: ${reload.error}`]),
      ].join("\n"),
      { ...reload, requestedBy, reason: normalizedReason },
    );
  }

  async #newSession(request: SlashCommandRequest, reason: string): Promise<SlashCommandResult> {
    const normalizedReason = reason.trim().length > 0 ? reason.trim() : "not_provided";
    const requestedBy = request.requestedBy ?? "unknown";
    if (this.#resetSession === undefined) {
      return handled(
        "new",
        false,
        "Session reset was recognized as a control-plane command, but full /new rotation is not wired for this frontend. Missing seam: full-agent session reset handler.",
        {
          sessionId: request.session.id,
          profileId: request.session.profileId,
          requestedBy,
          reason: normalizedReason,
          requestedAt: this.#now().toISOString(),
          missingSeam: "fullAgent_session_reset_handler",
        },
      );
    }
    const reset = await this.#resetSession({
      sessionId: request.session.id,
      requestedBy,
      reason: normalizedReason,
    });
    return handled(
      "new",
      true,
      [
        "Session reset complete.",
        `oldSessionId: ${reset.oldSessionId}`,
        `newSessionId: ${reset.newSessionId}`,
        `oldInstanceId: ${reset.oldInstanceId ?? "none"}`,
        `newInstanceId: ${reset.newInstanceId ?? "none"}`,
        `archivedMessageCount: ${String(reset.archivedMessageCount)}`,
        `resetAt: ${reset.resetAt}`,
      ].join("\n"),
      {
        ...reset,
        requestedBy,
        reason: normalizedReason,
      },
    );
  }
}

function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawCommand = "", ...rest] = trimmed.slice(1).split(/\s+/);
  const command = normalizeCommand(rawCommand);
  if (command === null) return null;
  return { command, argument: rest.join(" ") };
}

function normalizeCommand(command: string): SlashCommandName | null {
  if (command === "help") return "help";
  if (command === "status") return "status";
  if (command === "session") return "session";
  if (command === "new") return "new";
  if (command === "reload-mcp") return "reload-mcp";
  return null;
}

function handled(
  command: SlashCommandName,
  ok: boolean,
  message: string,
  evidence: Readonly<Record<string, unknown>>,
): SlashCommandResult {
  return { handled: true, command, ok, message, evidence };
}
