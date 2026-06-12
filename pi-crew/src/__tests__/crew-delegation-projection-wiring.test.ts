import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { Crew, CrewConfigSchema, type CrewConfig } from "../crew.js";

let nextPort = 29_236;

describe("Crew delegation projection wiring", () => {
  it("activates the Den delegation projection extension in the composition root", async () => {
    const logger = new FakeLogger();
    const eventBus = new FakeEventBus();
    const crew = new Crew(testConfig(), logger, eventBus);

    await crew.start();
    try {
      expect(logger.entries.some((entry) =>
        entry.level === "info" && entry.message === "DenDelegationProjectionExtension activated"
      )).toBe(true);
    } finally {
      await crew.stop("test-cleanup");
    }
  });
});

function testConfig(): CrewConfig {
  const parsed = CrewConfigSchema.safeParse({
    database: { path: join(mkdtempSync(join(tmpdir(), "pi-crew-projection-wiring-")), "runtime.db"), wal: true },
    health: { host: "127.0.0.1", port: nextPort++ },
    den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
  });
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}
