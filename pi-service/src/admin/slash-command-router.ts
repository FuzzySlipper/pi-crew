/** Frontend-independent control-plane slash command router. */

import type { DiagnosticsProjector } from "./admin-server.js";
import type { SessionRecord } from "../sessions/types.js";

export type SlashCommandName = "help" | "status" | "session" | "new" | "reload-mcp";

export interface SlashCommandRouterDeps {
  readonly diagnostics: DiagnosticsProjector;
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
  readonly #now: () => Date;

  constructor(deps: SlashCommandRouterDeps) {
    this.#diagnostics = deps.diagnostics;
    this.#now = deps.now ?? (() => new Date());
  }

  async tryHandle(request: SlashCommandRequest): Promise<SlashCommandResult> {
    const parsed = parseSlashCommand(request.input);
    if (parsed === null) return { handled: false };
    if (request.session.kind !== "conversational") {
      return handled(
        parsed.command,
        false,
        "Slash commands are only available for conversational sessions.",
        {
          sessionId: request.session.id,
          kind: request.session.kind,
        },
      );
    }
    if (parsed.command === "help") return this.#help();
    if (parsed.command === "status" || parsed.command === "session")
      return this.#status(request.session, parsed.command);
    if (parsed.command === "reload-mcp") return this.#reloadMcp(request.session);
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
        "- /reload-mcp — report MCP reload availability",
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

  #reloadMcp(session: SessionRecord): SlashCommandResult {
    return handled(
      "reload-mcp",
      false,
      "MCP hot reload is not yet available from the slash command router; use the admin config reload/control path or service restart until a narrow MCP reload seam is added.",
      { sessionId: session.id, missingSeam: "mcp_client_hot_reload" },
    );
  }

  #newSession(request: SlashCommandRequest, reason: string): SlashCommandResult {
    return handled(
      "new",
      false,
      "Session reset was recognized as a control-plane command, but full /new rotation is not yet enabled from this router. Missing seam: recreate conversational instance while preserving configured-agent binding and pre-reset capture.",
      {
        sessionId: request.session.id,
        profileId: request.session.profileId,
        requestedBy: request.requestedBy ?? "unknown",
        reason: reason.trim().length > 0 ? reason : "not_provided",
        requestedAt: this.#now().toISOString(),
        missingSeam: "configured_conversational_session_rotation",
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
