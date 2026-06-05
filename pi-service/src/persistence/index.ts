/**
 * Persistence module barrel exports.
 *
 * @module pi-service/persistence
 */

export { RuntimeDb, type RuntimeDbHealth } from "./runtime-db.js";
export { SqliteSessionRepository } from "./session-repository.js";
export { SqliteMessageRepository } from "./message-repository.js";
export { SqliteAuditRepository } from "./audit-repository.js";
export { StartupHydrator, type HydrationResult } from "./startup-hydration.js";

export {
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
} from "./types.js";
