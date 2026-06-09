/**
 * Tests for di.ts — dependency injection container.
 */

import { describe, it, expect } from "vitest";
import { FakeEventBus, FakeLogger, InMemoryHookRegistry } from "@pi-crew/core";
import { loadConfig } from "../config.js";
import { createServiceRegistry } from "../di.js";
import { InMemoryToolPolicySessionRegistry } from "../workers/tool-policy-extension.js";

describe("createServiceRegistry", () => {
  const config = loadConfig({ den: { coreUrl: "http://den-srv:3030" } });
  const logger = new FakeLogger();
  const eventBus = new FakeEventBus();
  const hookRegistry = new InMemoryHookRegistry(logger);
  const toolPolicySessionRegistry = new InMemoryToolPolicySessionRegistry();
  const options = { config, logger, eventBus, hookRegistry, toolPolicySessionRegistry };

  it("returns a registry with all provided services", () => {
    const reg = createServiceRegistry(options);

    expect(reg.config).toBe(config);
    expect(reg.logger).toBe(logger);
    expect(reg.eventBus).toBe(eventBus);
    expect(reg.hookRegistry).toBe(hookRegistry);
    expect(reg.toolPolicySessionRegistry).toBe(toolPolicySessionRegistry);
  });

  it("registry is a plain object (no hidden state)", () => {
    const reg = createServiceRegistry(options);
    expect(typeof reg).toBe("object");
    expect(reg).not.toBeNull();
  });

  it("config is the exact same validated GatewayConfig instance", () => {
    const reg = createServiceRegistry(options);
    expect(reg.config.den.coreUrl).toBe("http://den-srv:3030");
    expect(reg.config.health.port).toBe(9236);
  });

  it("each call returns a distinct object", () => {
    const a = createServiceRegistry(options);
    const b = createServiceRegistry(options);
    expect(a).not.toBe(b);
  });

  it("no singletons — registry does not resolve dependencies implicitly", () => {
    const reg = createServiceRegistry(options);
    expect("get" in reg).toBe(false);
    expect("resolve" in reg).toBe(false);
  });
});
