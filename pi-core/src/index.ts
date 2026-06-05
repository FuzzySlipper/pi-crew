// pi-core — Foundation types, interfaces, and utilities.
// Zero internal dependencies. Everything else builds on this.
//
// This barrel re-exports every public symbol from the individual
// source modules so consumers can write:
//
//   import { Result, GatewayError, ChannelProvider } from "@pi-crew/core";
//

// ── Domain types ──────────────────────────────────────────────
export {
  type Result,
  type ProjectId,
  type TaskId,
  type AssignmentId,
  type SessionId,
  type AgentIdentity,
  type RunId,
  type IsoTimestamp,
  ok,
  err,
} from "./types.js";

// ── Error hierarchy ───────────────────────────────────────────
export {
  GatewayError,
  ConfigurationError,
  ConnectionError,
  SessionLimitError,
  ProviderError,
  TimeoutError,
  AuthenticationError,
} from "./errors.js";

// ── Logger ────────────────────────────────────────────────────
export { type Logger, type LogContext } from "./logging.js";

// ── Events ────────────────────────────────────────────────────
export {
  type EventBus,
  type GatewayEvent,
  type EventPayload,
  type SessionCreatedPayload,
  type SessionExpiredPayload,
  type ToolCalledPayload,
  type ToolCompletedPayload,
  type BlackboardWrittenPayload,
  type AssignmentClaimedPayload,
  type AssignmentReleasedPayload,
  type TurnStartedPayload,
  type TurnCompletedPayload,
  type TurnErroredPayload,
  type TurnExhaustedPayload,
  type CheckpointWaitingPayload,
  type ContextPressurePayload,
  type WorkerStuckPayload,
  type GatewayShutdownPayload,
} from "./events.js";

// ── Repository ────────────────────────────────────────────────
export { type Repository } from "./repository.js";

// ── Channel ───────────────────────────────────────────────────
export {
  type ChannelProvider,
  type ChannelMessage,
  type ChannelParticipant,
  type ChannelContent,
  type MessageHandler,
  type SentMessage,
  type ChannelInfo,
  type ChannelBreadcrumb,
} from "./channel.js";

// ── Retry ─────────────────────────────────────────────────────
export {
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  retryWithBackoff,
} from "./retry.js";
