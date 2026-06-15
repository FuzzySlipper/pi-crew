import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEventBus, type Logger } from "@pi-crew/core";
import { RuntimeDb } from "../../persistence/runtime-db.js";
import { CronScheduler } from "../../cron/cron-scheduler.js";
import { ScriptCronJobExecutor } from "../../cron/script-cron-job-executor.js";
import { SqliteCronJobRepository } from "../../cron/sqlite-cron-job-repository.js";

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("CronScheduler", () => {
  it("runs due script jobs, records output, and reschedules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-cron-"));
    const db = new RuntimeDb({ path: join(dir, "runtime.db"), wal: true }, logger);
    try {
      const repository = new SqliteCronJobRepository(db.handle);
      await repository.upsert({ id: "job-1", projectId: "pi-crew", schedule: "* * * * *", shape: "script_only", script: "printf cron-ok", cwd: "." }, new Date("2026-06-15T09:00:00Z"));
      const scheduler = new CronScheduler({ repository, executor: new ScriptCronJobExecutor({ scriptRoot: dir }), logger, eventBus: new FakeEventBus(), tickIntervalMs: 60_000, runIdFactory: () => "run-1" });
      const runs = await scheduler.tick(new Date("2026-06-15T09:01:00Z"));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "succeeded", stdout: "cron-ok", exitCode: 0 });
      const job = await repository.get("job-1");
      expect(job?.lastRunAt).toBe("2026-06-15T09:01:00.000Z");
      expect(job?.nextRunAt).toBe("2026-06-15T09:02:00.000Z");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
