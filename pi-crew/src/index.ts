// pi-crew — Composition root: wires everything together into a pre-configured gateway.
// Depends on: all pi-* packages

export { Crew, bootstrap, loadCrewConfig, CrewConfigSchema, type CrewConfig } from "./crew.js";

export { Gateway, type GatewayConfig } from "@pi-crew/service";
export { type Logger, type GatewayEvent, type EventBus, type ChannelProvider } from "@pi-crew/core";
export { type Profile, type Skill, loadProfile } from "@pi-crew/profiles";
export { MCPClient, type ServerConfig, type AgentTool } from "@pi-crew/mcp";
export { DenChannelsAdapter, type DenChannelsAdapterConfig } from "@pi-crew/channels";
export { createToolRegistry, type ToolDefinition, type ToolRegistry } from "@pi-crew/tools";
export { BreadcrumbManager, AuditLogger } from "@pi-crew/governance";
export { type MemoryStore, type MemoryEntry } from "@pi-crew/memory";
export {
  createDenCompletionPoster,
  type DenCompletionPosterConfig,
} from "./den-completion-poster.js";
export {
  DenAssignmentRunnerError,
  createDenAssignmentRunner,
  type DenAssignmentRunner,
  type DenAssignmentRunnerConfig,
  type DenAssignmentRunnerResult,
  type DenAssignmentRunnerRuntime,
} from "./den-assignment-runner.js";
export {
  createDenAssignmentLoop,
  type DenAssignmentLoop,
  type DenAssignmentLoopConfig,
  type DenAssignmentLoopRunner,
  type DenAssignmentLoopTickResult,
} from "./den-assignment-loop.js";
export {
  createCrewAssignmentLoops,
  type CrewAssignmentLoopSource,
  type CrewAssignmentLoopsConfig,
} from "./crew-assignment-loops.js";
export {
  buildGroupOwnedPoolMemberSelector,
  resolveWorkerPoolCleanupGroups,
  resolveWorkerPoolMembers,
  type GroupOwnedPoolMemberCandidate,
  type GroupOwnedPoolMemberSelector,
  type GroupOwnedPoolMemberSelectorConfig,
  type WorkerPoolGroupConfig,
} from "./worker-pool-groups.js";
export {
  DenPoolSourceConfigurationError,
  createDenPoolAssignmentConsumer,
  createDenPoolMemberReconciler,
  type AssignmentReadback,
  type DegradedPoolMember,
  type DenPoolAssignmentConsumer,
  type DenPoolAssignmentResult,
  type DenPoolMemberConfig,
  type DenPoolMemberReadiness,
  type DenPoolMemberReconcileResult,
  type DenPoolMemberReconciler,
} from "./den-pool-source.js";
