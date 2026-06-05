/**
 * Tests for di.ts — dependency injection container.
 */

import { describe, it, expect } from "vitest";
import { FakeLogger, FakeEventBus } from "@pi-crew/core";
import { loadConfig } from "../config.js";
import { createServiceRegistry } from "../di.js";

describe("createServiceRegistry", () => {
  const config = loadConfig({ den: { coreUrl: "http://den-srv:3030" } });
  const logger = new FakeLogger();
  const eventBus = new FakeEventBus();

  it("returns a registry with all provided services", () => {
    const reg = createServiceRegistry({ config, logger, eventBus });

    expect(reg.config).toBe(config);
    expect(reg.logger).toBe(logger);
    expect(reg.eventBus).toBe(eventBus);
  });

  it("registry is a plain object (no hidden state)", () => {
    const reg = createServiceRegistry({ config, logger, eventBus });
    expect(typeof reg).toBe("object");
    expect(reg).not.toBeNull();
  });

  it("config is the exact same validated GatewayConfig instance", () => {
    const reg = createServiceRegistry({ config, logger, eventBus });
    expect(reg.config.den.coreUrl).toBe("http://den-srv:3030");
    expect(reg.config.health.port).toBe(9236);
  });

  it("each call returns a distinct object", () => {
    const a = createServiceRegistry({ config, logger, eventBus });
    const b = createServiceRegistry({ config, logger, eventBus });
    expect(a).not.toBe(b);
  });

  it("no singletons — registry does not resolve dependencies implicitly", () => {
    // The registry is just a bag of explicitly-provided references.
    // There is no get() or resolve() method — callers provide everything.
    const reg = createServiceRegistry({ config, logger, eventBus });
    expect("get" in reg).toBe(false);
    expect("resolve" in reg).toBe(false);
  });
});
