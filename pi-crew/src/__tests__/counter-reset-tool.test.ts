import { describe, expect, it } from "vitest";
import { createCounterResetTool, type CreateCounterResetToolInput } from "../counter-reset-tool.js";
import type { CounterService, CounterTriggerResult, CounterThresholds, TriggerType } from "@pi-crew/service";

describe("counter_reset tool", () => {
  const defaultInput: CreateCounterResetToolInput = {
    counterService: new FakeCounterService(),
    sessionId: "sess-test",
    profileId: "profile-test",
  };

  it("returns undefined when counterService is not provided", () => {
    const tool = createCounterResetTool({ ...defaultInput, counterService: undefined });
    expect(tool).toBeUndefined();
  });

  it("returns a tool with name counter_reset when counterService is provided", () => {
    const tool = createCounterResetTool(defaultInput);
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("counter_reset");
  });

  it("rejects invalid triggerType", async () => {
    const tool = createCounterResetTool(defaultInput)!;
    const result = await tool.execute("call-1", { triggerType: "invalid" });
    expect(result.details).toEqual({ ok: false, error: "invalid_trigger_type" });
  });

  it("resets memory counter on triggerType memory", async () => {
    const service = new FakeCounterService();
    const tool = createCounterResetTool({ ...defaultInput, counterService: service })!;

    const result = await tool.execute("call-1", { triggerType: "memory" });

    expect(result.details).toEqual({ ok: true, triggerType: "memory" });
    expect(service.resets).toEqual([{ profileId: "profile-test", sessionId: "sess-test", triggerType: "memory" }]);
  });

  it("resets skill counter on triggerType skill", async () => {
    const service = new FakeCounterService();
    const tool = createCounterResetTool({ ...defaultInput, counterService: service })!;

    const result = await tool.execute("call-1", { triggerType: "skill" });

    expect(result.details).toEqual({ ok: true, triggerType: "skill" });
    expect(service.resets).toEqual([{ profileId: "profile-test", sessionId: "sess-test", triggerType: "skill" }]);
  });

  it("resets both counters on triggerType combined", async () => {
    const service = new FakeCounterService();
    const tool = createCounterResetTool({ ...defaultInput, counterService: service })!;

    const result = await tool.execute("call-1", { triggerType: "combined" });

    expect(result.details).toEqual({ ok: true, triggerType: "combined" });
    expect(service.resets).toHaveLength(1);
    expect(service.resets[0]!.triggerType).toBe("combined");
  });

  it("includes session and profile context via closure", async () => {
    const service = new FakeCounterService();
    const tool = createCounterResetTool({
      counterService: service,
      sessionId: "sess-abc",
      profileId: "profile-xyz",
    })!;

    await tool.execute("call-1", { triggerType: "memory" });

    expect(service.resets[0]).toEqual({
      profileId: "profile-xyz",
      sessionId: "sess-abc",
      triggerType: "memory",
    });
  });
});

// ── Fake CounterService ──────────────────────────────────────────

interface ResetRecord {
  readonly profileId: string;
  readonly sessionId: string;
  readonly triggerType: TriggerType;
}

class FakeCounterService implements CounterService {
  readonly resets: ResetRecord[] = [];

  async incrementTurn(): Promise<void> {
    // no-op for tool tests
  }

  async incrementIteration(): Promise<void> {
    // no-op for tool tests
  }

  async checkTrigger(): Promise<CounterTriggerResult | null> {
    return null;
  }

  async resetCounter(profileId: string, sessionId: string, triggerType: TriggerType): Promise<void> {
    this.resets.push({ profileId, sessionId, triggerType });
  }

  async cleanupSession(): Promise<void> {
    // no-op for tool tests
  }
}
