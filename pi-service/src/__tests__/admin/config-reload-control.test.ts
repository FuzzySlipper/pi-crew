import { describe, expect, it } from "vitest";
import { FakeEventBus } from "@pi-crew/core";
import { RemediationControlService } from "../../admin/remediation-control-service.js";
import type { DiagnosticsOverview } from "../../diagnostics/types.js";
import type { AuditEventInput, AuditRepository, AuditRow } from "../../persistence/types.js";

describe("RemediationControlService config reload integration", () => {
  it("applies valid candidate config through the injected targeted reload applier", async () => {
    const audit = new FakeAuditRepository();
    const applied: unknown[] = [];
    const controls = new RemediationControlService({
      diagnostics: { projectOverview: () => Promise.resolve(overview()) },
      auditRepository: audit,
      eventBus: new FakeEventBus(),
      validateConfig: (raw: unknown) => ({ valid: raw !== null, errors: [] }),
      reloadConfig: (candidateConfig: unknown) => {
        applied.push(candidateConfig);
        return Promise.resolve({
          changedKeys: ["admin.port"],
          affectedExtensionIds: ["tool-policy"],
          nonReloadableKeys: [],
          reactivatedExtensionIds: ["tool-policy"],
          skippedExtensionIds: ["delegation-cleanup"],
          status: "reloaded",
          warnings: [],
        });
      },
      idFactory: () => `ctrl_${String(audit.rows.length + 1)}`,
    });

    const candidateConfig = { den: { coreUrl: "http://den-srv:3030" }, admin: { port: 9240 } };
    const result = await controls.reloadConfig({
      operator: "patch",
      reason: "targeted reload smoke",
      idempotencyKey: "reload-1",
      candidateConfig,
    });

    expect(result.accepted).toBe(true);
    expect(applied).toEqual([candidateConfig]);
    expect(result.after).toEqual({
      validationCache: "reload-1",
      applied: true,
      changedKeys: ["admin.port"],
      affectedExtensionIds: ["tool-policy"],
      reactivatedExtensionIds: ["tool-policy"],
      skippedExtensionIds: ["delegation-cleanup"],
      reloadStatus: "reloaded",
    });
    expect(audit.rows[0]?.eventType).toBe("admin.control.config_reload");
  });

  it("validates dry-run reloads without calling the applier", async () => {
    const controls = new RemediationControlService({
      diagnostics: { projectOverview: () => Promise.resolve(overview()) },
      auditRepository: new FakeAuditRepository(),
      eventBus: new FakeEventBus(),
      validateConfig: () => ({ valid: true, errors: [] }),
      reloadConfig: () => Promise.reject(new Error("dry run must not apply reload")),
    });

    const result = await controls.reloadConfig({
      operator: "patch",
      reason: "dry run",
      idempotencyKey: "reload-dry-run",
      dryRun: true,
      candidateConfig: { den: { coreUrl: "http://den-srv:3030" } },
    });

    expect(result.accepted).toBe(true);
    expect(result.after).toBeNull();
    expect(result.warnings).toContain("dry run; targeted extension reload not applied");
  });
});

class FakeAuditRepository implements AuditRepository {
  readonly rows: AuditEventInput[] = [];

  write(input: AuditEventInput): Promise<number> {
    this.rows.push(input);
    return Promise.resolve(this.rows.length);
  }

  getPending(): Promise<AuditRow[]> {
    return Promise.resolve([]);
  }

  markFlushed(): Promise<void> {
    return Promise.resolve();
  }

  pruneOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
}

function overview(): DiagnosticsOverview {
  return {
    service: { status: "ok", version: "test", uptimeSeconds: 1, startedAt: "1970-01-01T00:00:00.000Z", drainMode: "inactive" },
    classification: { kind: "healthy", summary: "test" },
    denCore: { status: "ok", lastOkAt: "1970-01-01T00:00:00.000Z" },
    denChannels: { status: "ok", lastOkAt: "1970-01-01T00:00:00.000Z" },
    mcp: { status: "ok", lastOkAt: "1970-01-01T00:00:00.000Z" },
    runtimeDb: { status: "ok", path: ":memory:", walEnabled: true, tableCount: 1, schemaVersion: 1 },
    counts: { activeSessions: 0, workerSessions: 0, conversationalSessions: 0, activeAssignmentsLocal: 0, stuckWorkers: 0, checkpointWaiting: 0 },
    sessions: [],
    recentEvents: [],
  } as const;
}
