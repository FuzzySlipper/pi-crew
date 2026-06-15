/** Shared types for direct debug/admin diagnostic route collaborators. */

export interface DirectDebugTurnInput {
  readonly sessionId: string;
  readonly message: string;
  readonly emitDenVisibility?: boolean;
  readonly contextDiagnostics?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DirectDebugTurnResult {
  readonly sessionId: string;
  readonly turnId: string;
  readonly message: string;
  readonly toolCalls: readonly unknown[];
  readonly delegationHandles: readonly unknown[];
  readonly events: readonly unknown[];
  readonly diagnostics: unknown;
  readonly diagnosticOnly: boolean;
}

export interface DirectDebugServicePort {
  runTurn(input: DirectDebugTurnInput): Promise<DirectDebugTurnResult>;
}

export interface ToolInventoryProjector {
  projectTools(sessionId?: string): Promise<unknown>;
}

export interface DirectDebugMessageView {
  readonly id: number;
  readonly role: string;
  readonly content: string;
  readonly toolName: string | null;
  readonly tokenCount: number | null;
  readonly createdAt: string;
}

export interface DirectDebugSessionContextView {
  readonly sessionId: string;
  readonly limit: number;
  readonly messageCount: number;
  readonly messages: readonly DirectDebugMessageView[];
  readonly contextPressure: unknown;
  readonly contextCompaction: unknown;
}

export interface DirectDebugContextProjector {
  projectContext(sessionId: string, limit: number): Promise<DirectDebugSessionContextView>;
}
