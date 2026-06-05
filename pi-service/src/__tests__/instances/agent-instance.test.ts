/**
 * Tests for AgentInstance and InstanceFactory.
 *
 * @module pi-service/__tests__/instances/agent-instance.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { AgentInstanceImpl } from "../../instances/agent-instance.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";

describe("AgentInstanceImpl", () => {
  it("creates with a unique id", () => {
    const a = new AgentInstanceImpl("test-profile");
    const b = new AgentInstanceImpl("test-profile");

    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it("stores profileId", () => {
    const instance = new AgentInstanceImpl("spawned-coder");
    expect(instance.profileId).toBe("spawned-coder");
  });

  it("sets createdAt to now", () => {
    const before = new Date();
    const instance = new AgentInstanceImpl("test");
    expect(instance.createdAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
  });

  it("is not disposed initially", () => {
    const instance = new AgentInstanceImpl("test");
    expect(instance.isDisposed).toBe(false);
  });

  it("dispose sets isDisposed to true", async () => {
    const instance = new AgentInstanceImpl("test");
    await instance.dispose();
    expect(instance.isDisposed).toBe(true);
  });

  it("dispose is idempotent", async () => {
    const instance = new AgentInstanceImpl("test");
    await instance.dispose();
    await instance.dispose();
    expect(instance.isDisposed).toBe(true);
  });

  it("accepts a custom id", () => {
    const instance = new AgentInstanceImpl("test", "custom-42");
    expect(instance.id).toBe("custom-42");
  });
});

describe("InstanceFactoryImpl", () => {
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
  });

  it("creates an instance from a profile", async () => {
    const factory = new InstanceFactoryImpl(logger);
    const instance = await factory.create("default");

    expect(instance.profileId).toBe("default");
    expect(instance.isDisposed).toBe(false);
  });

  it("logs instance creation", async () => {
    const factory = new InstanceFactoryImpl(logger);
    await factory.create("default");

    const debugLogs = logger.entries.filter((e) => e.level === "debug");
    expect(debugLogs.length).toBeGreaterThanOrEqual(1);
    expect(debugLogs.at(0)?.message).toContain("Creating agent instance");
  });

  it("creates instances with unique ids", async () => {
    const factory = new InstanceFactoryImpl(logger);
    const a = await factory.create("default");
    const b = await factory.create("default");

    expect(a.id).not.toBe(b.id);
  });
});
