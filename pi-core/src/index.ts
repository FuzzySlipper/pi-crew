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
  type WorkerPolicy,
  type DrainModeState,
  type ContextPressureSnapshot,
  type CompletionStatus,
  type CompletionPacket,
  type CompletionArtifact,
  type CompletionBlocker,
  type CompletionPostResult,
  DRAIN_MODE_ESSENTIAL_TOOLS,
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
  PolicyViolationError,
  ToolDeniedError,
  CompletionRejectedError,
} from "./errors.js";

// ── Logger ────────────────────────────────────────────────────
export { type Logger, type LogContext } from "./logging.js";

// ── Events ────────────────────────────────────────────────────
export {
  type EventBus,
  type GatewayEvent,
  type EventPayload,
  type SessionCreatedPayload,
  type SessionRoutingPayload,
  type SessionExpiredPayload,
  type ToolCalledPayload,
  type ToolCompletedPayload,
  type BlackboardWrittenPayload,
  type AssignmentClaimedPayload,
  type AssignmentReleasedPayload,
  type AssignmentTimedOutPayload,
  type TurnStartedPayload,
  type TurnCompletedPayload,
  type TurnErroredPayload,
  type TurnExhaustedPayload,
  type CheckpointWaitingPayload,
  type ContextPressurePayload,
  type WorkerStuckPayload,
  type GatewayShutdownPayload,
  type ToolDeniedPayload,
  type DrainActivatedPayload,
  type DrainDeactivatedPayload,
  type PolicyEnforcedPayload,
  type CompletionPostedPayload,
  type SessionRehydratedPayload,
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
export { type RetryPolicy, DEFAULT_RETRY_POLICY, retryWithBackoff } from "./retry.js";

// ── Test helpers ───────────────────────────────────────────────
// Co-located in test-helpers/ but exported directly (no nested barrel).
export { InMemoryRepository } from "./test-helpers/in-memory-repository.js";
export { FakeEventBus } from "./test-helpers/fake-event-bus.js";
export { SpyEventBus, type SpyEventRecord } from "./test-helpers/spy-event-bus.js";
export { FakeLogger, type LogEntry } from "./test-helpers/fake-logger.js";
export { FakeChannelProvider } from "./test-helpers/fake-channel-provider.js";
