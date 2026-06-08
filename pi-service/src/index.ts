// pi-service — Daemon runtime and orchestrator.
// Depends on: pi-core, pi-profiles, pi-mcp

export { Gateway } from "./gateway.js";
export {
  loadConfig,
  GatewayConfigSchema,
  type GatewayConfig,
  type AdminConfig,
  type DatabaseConfig,
  type DenConfig,
  type HealthConfig,
  type LoggingConfig,
  type RuntimeConfig,
} from "./config.js";
export {
  createServiceRegistry,
  type ServiceRegistry,
  type CreateRegistryOptions,
} from "./di.js";

// ── Sessions ────────────────────────────────────────────────────
export {
  type SessionKind,
  type SessionState,
  type WorkerBinding,
  type ChannelBinding,
  type ChannelBindingRecord,
  type SessionRecord,
  type SessionConfig,
} from "./sessions/types.js";
export {
  type SessionStore,
  InMemorySessionStore,
} from "./sessions/session-store.js";
export {
  type SessionManager,
  SessionManagerImpl,
} from "./sessions/session-manager.js";
export { SessionPresenceBridge } from "./sessions/session-presence-bridge.js";

// ── Instances ───────────────────────────────────────────────────
export {
  type AgentInstance,
  AgentInstanceImpl,
} from "./instances/agent-instance.js";
export {
  type AgentResponseRequest,
  type AgentResponder,
  type AgentResponderFactory,
  type AgentResponderFactoryContext,
  EchoAgentResponder,
  EchoAgentResponderFactory,
} from "./instances/agent-responder.js";
export {
  type DeterministicArithmeticRequest,
  type DeterministicArithmeticResult,
  type DeterministicRuntimeTool,
  type DeterministicToolAgentResponderFactoryOptions,
  type DeterministicToolAgentResponderOptions,
  DeterministicArithmeticTool,
  DeterministicToolAgentResponder,
  DeterministicToolAgentResponderFactory,
  parseDeterministicArithmeticRequest,
} from "./instances/deterministic-tool-responder.js";
export {
  type InstanceFactory,
  InstanceFactoryImpl,
} from "./instances/instance-factory.js";
export {
  type InstancePool,
  type InstancePoolConfig,
  DEFAULT_POOL_CONFIG,
  InstancePoolImpl,
} from "./instances/instance-pool.js";

// ── Agents ──────────────────────────────────────────────────────
export {
  type AgentFactory,
  AgentFactoryImpl,
} from "./agents/agent-factory.js";

// ── Persistence ──────────────────────────────────────────────────
export {
  RuntimeDb,
  type RuntimeDbHealth,
  SqliteSessionRepository,
  SqliteMessageRepository,
  SqliteAuditRepository,
  StartupHydrator,
  type HydrationResult,
  type SessionRow,
  type MessageRow,
  type AuditRow,
  type RuntimeKVRow,
  type MessageInput,
  type AuditEventInput,
  type Migration,
  type MessageRepository,
  type AuditRepository,
  type SqliteSessionStore,
  type DenAssignmentStatus,
  type DenAssignmentReader,
  rowToRecord,
  recordToRow,
} from "./persistence/index.js";

// ── Workers ──────────────────────────────────────────────────────
export {
  DenSimulator,
  DenSimulatorError,
  type DenAssignment,
  type DenAssignmentState,
  DEN_WORKER_API_PREREQUISITES,
} from "./workers/den-simulator.js";
export {
  WorkerRuntime,
  type WorkerRuntimeConfig,
  type WorkerExecutor,
  type WorkerExecutionContext,
  type WorkerExecutionResult,
} from "./workers/worker-runtime.js";
export { AssignmentTimeoutError } from "./workers/worker-timeout.js";
export {
  type WorkerRoleBinding,
  type WorkerRoleConfig,
  type WorkerRoleMappingConfig,
  type RoleToolPolicy,
  REQUIRED_WORKER_ROLES,
  DEFAULT_WORKER_ROLE_BINDINGS,
  WorkerRoleBindingSchema,
  WorkerRoleMappingConfigSchema,
  loadWorkerRoleMapping,
  resolveProfileId,
  resolveRoleConfig,
} from "./workers/worker-role-config.js";
export {
  AgentSupervisor,
  type AgentSupervisorConfig,
  type AgentLike,
  type AgentToolRef,
  type SteerableAgent,
} from "./workers/agent-supervisor.js";
export {
  AgentRuntimeRegistry,
  type AgentRuntimeEntry,
} from "./workers/agent-runtime-registry.js";
export {
  PacketAuditor,
  type AuditFinding,
  type AuditResult,
} from "./workers/packet-auditor.js";
export {
  DiagnosticsService,
  type DiagnosticsServiceDeps,
} from "./diagnostics/diagnostics-service.js";
export {
  InMemoryDiagnosticEventJournal,
  redactDiagnosticValue,
} from "./diagnostics/event-journal.js";
export type {
  DiagnosticClassification,
  DiagnosticClassificationKind,
  DiagnosticContextPressure,
  DiagnosticCounts,
  DiagnosticEventJournal,
  DiagnosticEventRecord,
  DiagnosticSessionProjection,
  DiagnosticStatusReader,
  DiagnosticStatusSnapshot,
  DiagnosticsOverview,
  ReachabilityStatus,
  RuntimeHealthReader,
  RuntimeHealthSnapshot,
} from "./diagnostics/types.js";
export {
  AdminServer,
  isLoopbackHost,
  type AdminServerDeps,
  type DiagnosticsProjector,
} from "./admin/admin-server.js";
export {
  RemediationControlService,
  type ConfigValidationResult,
  type DenEvidence,
  type RemediationAction,
  type RemediationEvidenceInput,
  type RemediationEvidencePoster,
  type RemediationRequest,
  type RemediationResult,
} from "./admin/remediation-control-service.js";
export {
  type PacketAuditFetchFailure,
  type PacketCompletionReader,
} from "./workers/packet-auditor-workflow.js";
