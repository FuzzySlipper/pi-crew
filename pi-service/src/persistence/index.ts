/**
 * Persistence module barrel exports.
 *
 * @module pi-service/persistence
 */

export { RuntimeDb, type RuntimeDbHealth } from "./runtime-db.js";
export { SqliteSessionRepository } from "./session-repository.js";
export { SqliteMessageRepository } from "./message-repository.js";
export { SqlitePendingChildRepository } from "./pending-child-repository.js";
export { MessageRepositoryTurnHistory } from "./message-turn-history.js";
export { SqliteAuditRepository } from "./audit-repository.js";
export { SqliteAgentWorkBreadcrumbRepository } from "./agent-work-breadcrumb-repository.js";
export { StartupHydrator, type HydrationResult } from "./startup-hydration.js";

export { SqliteDenseProfileMemoryStore } from "./dense-profile-memory-store.js";

export { DefaultCounterService, SqliteCounterRepository, type CounterService } from "../counters/counter-service.js";

export {
  type SessionRow,
  type MessageRow,
  type AuditRow,
  type RuntimeKVRow,
  type CounterRow,
  type CounterTriggerResult,
  type CounterThresholds,
  type TriggerType,
  type MessageInput,
  type AuditEventInput,
  type Migration,
  type MessageRepository,
  type SessionSearchHit,
  type SessionSearchBrowseRow,
  type SessionSearchRepository,
  type AuditRepository,
  type SqliteSessionStore,
  type DenAssignmentStatus,
  type DenAssignmentReader,
  rowToRecord,
  recordToRow,
} from "./types.js";
