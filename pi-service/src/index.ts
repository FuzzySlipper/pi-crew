// pi-service — Daemon runtime and orchestrator.
// Depends on: pi-core, pi-profiles, pi-mcp

export { Gateway } from "./gateway.js";
export {
  loadConfig,
  GatewayConfigSchema,
  type GatewayConfig,
  type DatabaseConfig,
  type DenConfig,
  type HealthConfig,
  type LoggingConfig,
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

// ── Instances ───────────────────────────────────────────────────
export {
  type AgentInstance,
  AgentInstanceImpl,
} from "./instances/agent-instance.js";
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
