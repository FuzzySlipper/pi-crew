/**
 * Type definitions bridging pi-agent-core AgentTool contract
 * for the guarded tool assembly layer.
 *
 * These are structural types that mirror the pi-agent-core exports
 * at /home/research/pi-fleet/pi/packages/agent/src/types.ts without
 * importing from the external package directly. The guarded assembly
 * produces objects that satisfy these structural interfaces.
 *
 * @module pi-service/workers/guarded-tool-types
 */

// ── AgentToolResult ───────────────────────────────────────────────

/** Text content block within a tool result. */
export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

/** Image content block within a tool result. */
export interface ImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/**
 * Final or partial result produced by a tool.
 * Mirrors pi-agent-core `AgentToolResult<T>`.
 */
export interface AgentToolResult<T = unknown> {
  /** Text or image content returned to the model. */
  readonly content: readonly (TextContent | ImageContent)[];
  /** Arbitrary structured details for logs or UI rendering. */
  readonly details: T;
  /** Hint that the agent should stop after the current tool batch. */
  readonly terminate?: boolean;
}

// ── AgentTool ────────────────────────────────────────────────────

/**
 * Tool definition consumable by pi-agent-core Agent.
 *
 * Mirrors pi-agent-core `AgentTool<TParameters, TDetails>` with
 * the fields needed for policy wrapping.
 */
export interface AgentTool {
  /** Human-readable label for UI display. */
  readonly label: string;
  /** Unique machine-readable name. */
  readonly name: string;
  /** Human-readable description shown to the agent. */
  readonly description: string;
  /** JSON Schema describing the tool's input parameters. */
  readonly parameters: unknown;
  /** Execute the tool call. */
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult) => void,
  ): Promise<AgentToolResult>;
}

// ── Before / After tool call context & result ───────────────────

/** Result returned from `beforeToolCall`. Mirrors pi-agent-core. */
export interface BeforeToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
}

/** Context passed to `beforeToolCall`. Mirror of pi-agent-core. */
export interface BeforeToolCallContext {
  readonly toolCall: {
    readonly type: string;
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  };
  readonly args: unknown;
}

/** Result returned from `afterToolCall`. Mirrors pi-agent-core. */
export interface AfterToolCallResult {
  readonly content?: readonly (TextContent | ImageContent)[];
  readonly details?: unknown;
  readonly isError?: boolean;
  readonly terminate?: boolean;
}

/** Context passed to `afterToolCall`. Mirror of pi-agent-core. */
export interface AfterToolCallContext {
  readonly toolCall: {
    readonly type: string;
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  };
  readonly args: unknown;
  readonly result: AgentToolResult;
  readonly isError: boolean;
}
