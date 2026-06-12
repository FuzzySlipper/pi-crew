import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeChannelProvider, FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { DelegationSpawnedPayload } from "@pi-crew/core";
import { DenDelegationProjectionExtension } from "../../workers/den-delegation-projection.js";
import type { ServiceExtensionContext } from "../../extension-activator.js";

function createContext(eventBus: FakeEventBus, logger: FakeLogger): ServiceExtensionContext {
  return {
    eventBus,
    logger,
    config: undefined as unknown as ServiceExtensionContext["config"],
    hookRegistry: undefined as unknown as ServiceExtensionContext["hookRegistry"],
    delegationSessions: undefined as unknown as ServiceExtensionContext["delegationSessions"],
  };
}

function spawnedPayload(): DelegationSpawnedPayload {
  return {
    childSessionId: "child-1",
    lineage: {
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
      childSessionId: "child-1",
      depth: 1,
      chain: ["root-1", "child-1"],
    },
    policyId: "policy-1",
    task: "Inspect a bounded task excerpt without raw transcript data",
    effectiveRuntime: { profileId: "coder-child", provider: "local", model: "test-model" },
  };
}

describe("delegation projection sinks", () => {
  it("can disable channel projection while appending local text records", async () => {
    const channel = new FakeChannelProvider();
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const logPath = join(mkdtempSync(join(tmpdir(), "pi-projection-")), "delegation.log");
    const extension = new DenDelegationProjectionExtension({
      channelProvider: channel,
      channelId: "642",
      channelEnabled: false,
      localLogEnabled: true,
      localLogPath: logPath,
    });

    await extension.activate(createContext(eventBus, logger));
    eventBus.emit({ event: "delegation.spawned", payload: spawnedPayload() });
    await Promise.resolve();

    expect(channel.sentMessages).toHaveLength(0);
    const line = readFileSync(logPath, "utf8").trim();
    expect(line).toContain('"eventName":"delegation.spawned"');
    expect(line).toContain('"childSessionId":"child-1"');
  });

  it("can keep channel projection enabled while also appending local records", async () => {
    const channel = new FakeChannelProvider();
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const logPath = join(mkdtempSync(join(tmpdir(), "pi-projection-")), "delegation.log");
    const extension = new DenDelegationProjectionExtension({
      channelProvider: channel,
      channelId: "642",
      channelEnabled: true,
      localLogEnabled: true,
      localLogPath: logPath,
    });

    await extension.activate(createContext(eventBus, logger));
    eventBus.emit({ event: "delegation.spawned", payload: spawnedPayload() });
    await Promise.resolve();

    expect(channel.sentMessages).toHaveLength(1);
    expect(readFileSync(logPath, "utf8")).toContain("delegation.spawned");
  });
});
