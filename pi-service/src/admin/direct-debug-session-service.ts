/** Direct diagnostic turns for existing conversational sessions. */

import type {
  ChannelBreadcrumb,
  ChannelContent,
  ChannelInfo,
  ChannelProvider,
} from "@pi-crew/core";
import type {
  DiagnosticsProjector,
  DirectDebugTurnInput,
  DirectDebugTurnResult,
} from "./admin-server.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { ChannelBinding, SessionRecord } from "../sessions/types.js";

interface DirectDebugSessionServiceDeps {
  readonly sessionManager: SessionManager;
  readonly diagnostics: DiagnosticsProjector;
  readonly idFactory?: () => string;
}

const DEFAULT_SOURCE = "direct-debug-cli";

export class DirectDebugSessionService {
  readonly #sessionManager: SessionManager;
  readonly #diagnostics: DiagnosticsProjector;
  readonly #idFactory: () => string;

  constructor(deps: DirectDebugSessionServiceDeps) {
    this.#sessionManager = deps.sessionManager;
    this.#diagnostics = deps.diagnostics;
    this.#idFactory = deps.idFactory ?? (() => `direct-debug-${Date.now().toString(36)}`);
  }

  async runTurn(input: DirectDebugTurnInput): Promise<DirectDebugTurnResult> {
    const session = await this.#sessionManager.get(input.sessionId);
    if (session === null) throw new DirectDebugSessionError(`Session ${input.sessionId} not found`);
    if (session.kind !== "conversational") {
      throw new DirectDebugSessionError("Direct debug turns only support conversational sessions");
    }
    const channelId = firstChannelId(session);
    if (channelId === null) {
      throw new DirectDebugSessionError(`Session ${input.sessionId} has no channel binding`);
    }
    const provider = new CapturingDirectDebugChannelProvider();
    const turnId = this.#idFactory();
    await this.#sessionManager.routeDiagnosticMessage(input.sessionId, provider, {
      id: turnId,
      channelId,
      sender: { id: DEFAULT_SOURCE, displayName: "Direct Debug", kind: "human", platform: "debug" },
      content: { kind: "text", text: input.message },
      timestamp: new Date(),
      metadata: {
        source: readSource(input.metadata),
        diagnosticOnly: true,
        contextDiagnostics: input.contextDiagnostics === true,
        emitDenVisibility: input.emitDenVisibility === true,
      },
    });
    const overview = await this.#diagnostics.projectOverview();
    return {
      sessionId: input.sessionId,
      turnId,
      message: provider.lastText() ?? "",
      toolCalls: [],
      delegationHandles: [],
      events: overview.recentEvents.slice(-50),
      diagnostics: input.contextDiagnostics === true ? { sessionId: input.sessionId } : null,
      diagnosticOnly: true,
    };
  }
}

export class DirectDebugSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectDebugSessionError";
  }
}

function firstChannelId(session: SessionRecord): string | null {
  const binding = session.channelBindings[0];
  if (binding === undefined) return null;
  return channelIdFromBinding(binding);
}

function channelIdFromBinding(binding: ChannelBinding): string {
  return typeof binding === "string" ? binding : binding.channelId;
}

function readSource(metadata: Readonly<Record<string, unknown>> | undefined): string {
  const value = metadata?.["source"];
  return typeof value === "string" && value.trim().length > 0 ? value : DEFAULT_SOURCE;
}

class CapturingDirectDebugChannelProvider implements ChannelProvider {
  readonly name = "direct-debug";
  readonly providerId = "direct-debug";
  readonly isConnected = true;
  readonly #messages: ChannelContent[] = [];

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  listChannels(): Promise<ChannelInfo[]> {
    return Promise.resolve([]);
  }

  channelExists(_channelId: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  onMessage(_handler: Parameters<ChannelProvider["onMessage"]>[0]): void {}

  sendMessage(channelId: string, content: ChannelContent) {
    this.#messages.push(content);
    return Promise.resolve({
      id: `direct-debug-response-${String(this.#messages.length)}`,
      channelId,
      timestamp: new Date(),
    });
  }

  updateMessage(_channelId: string, _messageId: string, _content: ChannelContent): Promise<void> {
    return Promise.resolve();
  }

  deleteMessage(_channelId: string, _messageId: string): Promise<void> {
    return Promise.resolve();
  }

  sendBreadcrumb(_breadcrumb: ChannelBreadcrumb): Promise<void> {
    return Promise.resolve();
  }

  updateBreadcrumb(
    _breadcrumbId: string,
    _update: Partial<Pick<ChannelBreadcrumb, "status" | "description">>,
  ): Promise<void> {
    return Promise.resolve();
  }

  lastText(): string | null {
    const content = this.#messages.at(-1);
    if (content === undefined) return null;
    return textFromContent(content);
  }
}

function textFromContent(content: ChannelContent): string {
  if (content.kind === "text") return content.text;
  if (content.kind === "media") return content.altText ?? content.url;
  return content.parts.map(textFromContent).join("\n");
}
