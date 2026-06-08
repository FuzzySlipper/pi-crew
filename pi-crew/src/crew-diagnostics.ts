/** Diagnostics wiring for the pi-crew composition root. */
import type { EventBus } from "@pi-crew/core";
import {
  DiagnosticsService,
  InMemoryDiagnosticEventJournal,
  type DenAssignmentReader,
  type DiagnosticStatusReader,
  type RuntimeDb,
  type RuntimeHealthReader,
  type SessionStore,
} from "@pi-crew/service";

interface CrewDiagnosticsDeps {
  readonly eventBus: EventBus;
  readonly runtimeDb: RuntimeDb;
  readonly sessionStore: SessionStore;
}

export function createCrewDiagnostics(deps: CrewDiagnosticsDeps): DiagnosticsService {
  return new DiagnosticsService({
    sessionStore: deps.sessionStore,
    eventJournal: new InMemoryDiagnosticEventJournal(deps.eventBus),
    runtimeHealthReader: new RuntimeDbStatusReader(deps.runtimeDb),
    denCoreStatusReader: statusReader("degraded"),
    denChannelsStatusReader: statusReader("degraded"),
    mcpStatusReader: statusReader("degraded"),
    denAssignmentReader: new EmptyDenAssignmentReader(),
    startedAt: new Date().toISOString(),
    version: "pi-crew",
  });
}

class RuntimeDbStatusReader implements RuntimeHealthReader {
  readonly #runtimeDb: RuntimeDb;

  constructor(runtimeDb: RuntimeDb) {
    this.#runtimeDb = runtimeDb;
  }

  health() {
    const health = this.#runtimeDb.health();
    if (!this.#runtimeDb.isOpen) return { status: "failed", error: "runtime db is closed" } as const;
    return {
      status: "ok",
      path: health.path,
      walEnabled: health.walEnabled,
      tableCount: health.tableCount,
      schemaVersion: health.schemaVersion,
    } as const;
  }
}

class EmptyDenAssignmentReader implements DenAssignmentReader {
  checkAssignments() {
    return Promise.resolve([]);
  }
}

function statusReader(status: "ok" | "degraded" | "unreachable"): DiagnosticStatusReader {
  return {
    readStatus: () => Promise.resolve({ status, lastOkAt: null }),
  };
}
