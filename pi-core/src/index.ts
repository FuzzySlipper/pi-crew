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
  type ArtifactKind,
  type CompletionBlocker,
  type CompletionPostResult,
  DRAIN_MODE_ESSENTIAL_TOOLS,
  ok,
  err,
} from "./types.js";

// ── Security policy ───────────────────────────────────────────
export {
  type ExecutionPolicy,
  type CredentialAccessLevel,
  type PolicyCheckResult,
  type SandboxLevel,
  type SandboxBackend,
  type SandboxContext,
} from "./security.js";

// ── Delegation foundation ──────────────────────────────────────
export {
  createChildDelegationLineage,
  type CreateChildDelegationLineageInput,
  type SessionKind,
  type DelegationLineage,
  type DelegationConstraints,
  type DelegationModelSelection,
  type EffectiveDelegationRuntime,
  type DelegationSpawnRequest,
  type DelegatedResult,
  type DelegatedPolicyDerivation,
  type DelegationVisibilityIdentity,
  type DelegatedArtifactHandle,
  type DelegatedFailureCategory,
} from "./delegation.js";

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
  SpawnDepthExceededError,
  ConcurrentChildrenExceededError,
  DelegationTimeoutError,
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
  type MessageStartedPayload,
  type MessageUpdatedPayload,
  type MessageCompletedPayload,
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
  type SessionPresenceBindingPayload,
  type SessionPresencePayload,
  type DelegationVisibilityPayload,
  type DelegationSpawnedPayload,
  type DelegationTurnVisiblePayload,
  type DelegationToolVisiblePayload,
  type DelegationCompletedPayload,
  type DelegationTimeoutPayload,
  type DelegationKilledPayload,
  type DelegationOrphanDetectedPayload,
  type OperatorControlRequestedPayload,
  type OperatorControlCompletedPayload,
  type WorkerCloseoutAssessedPayload,
} from "./events.js";

// ── Hook registry / extensions ───────────────────────────────
export {
  InMemoryHookRegistry,
  type HookRegistry,
  type HookCatalog,
  type HookName,
  type HookKind,
  type HookPayload,
  type HookReturn,
  type HookHandler,
  type HookRegistrationOptions,
  type GateResult,
  type ModifierResult,
  type ObserverResult,
  type HookDenCorrelation,
  type BeforeToolCallPayload,
  type AfterToolCallPayload,
  type AfterToolCallResultSnapshot,
  type AfterToolCallModifier,
  type BeforeAgentStartPayload,
  type BeforeAgentStartModifier,
  type AfterAgentStartPayload,
  type BeforeMessageSendPayload,
  type AfterMessageSendPayload,
  type BeforeSessionCreatePayload,
  type BeforeCompactionPayload,
  type AfterCompactionPayload,
  type BeforeCompletionPostPayload,
  type BeforeCompletionPostModifier,
  type BeforeDrainActivatePayload,
  type AgentContextInjectPayload,
  type AgentContextInjectModifier,
  type MessageContentSnapshot,
} from "./hooks.js";

export {
  type Extension,
  type ExtensionContext,
  type ExtensionConfigInterest,
} from "./extension.js";

// ── Delegation operator controls ──────────────────────────────
export {
  type OperatorControlAction,
  type OperatorControlRequest,
  type OperatorControlResult,
  type ChildSessionCheckpoint,
  type OperatorControlPolicy,
  type UnknownServiceSessionView,
} from "./delegation-operator-control.js";

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

export {
  type ChannelMemberType,
  type ChannelMembershipStatus,
  type ChannelSubscriptionPurpose,
  type ChannelSubscriptionStatus,
  type ChannelPresenceState,
  type ChannelWakePolicy,
  type ChannelWorkRefs,
  type ChannelEvidenceRefs,
  type ChannelMembershipUpsert,
  type ChannelMembership,
  type ChannelSubscriptionUpsert,
  type ChannelSubscription,
  type ChannelSubscriptionRelease,
  type ChannelSubscriptionStatusUpdate,
  type ChannelPresenceQuery,
  type ChannelPresence,
  type ChannelMembershipProvider,
  type ChannelPresenceProvider,
  isChannelMembershipProvider,
  isChannelPresenceProvider,
} from "./channel-presence.js";

// ── Retry ─────────────────────────────────────────────────────
export { type RetryPolicy, DEFAULT_RETRY_POLICY, retryWithBackoff } from "./retry.js";

// ── Frontmatter extraction ───────────────────────────────────
export {
  type FrontmatterExtraction,
  extractFrontmatter,
  stripFrontmatter,
} from "./frontmatter.js";

// ── Skills ───────────────────────────────────────────────────
export {
  type SkillFrontmatter,
  type SkillConfigVar,
  type SkillRecord,
  type SkillQuery,
  parseSkillFrontmatter,
} from "./skills.js";

// ── Test helpers ───────────────────────────────────────────────
// Co-located in test-helpers/ but exported directly (no nested barrel).
export { InMemoryRepository } from "./test-helpers/in-memory-repository.js";
export { FakeEventBus } from "./test-helpers/fake-event-bus.js";
export { SpyEventBus, type SpyEventRecord } from "./test-helpers/spy-event-bus.js";
export { FakeLogger, type LogEntry } from "./test-helpers/fake-logger.js";
export { FakeChannelProvider } from "./test-helpers/fake-channel-provider.js";
export { FakeMembershipChannelProvider } from "./test-helpers/fake-membership-channel-provider.js";
