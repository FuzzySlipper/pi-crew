import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger, InMemoryHookRegistry } from "@pi-crew/core";
import { loadConfig, type GatewayConfig } from "../config.js";
import {
  ExtensionActivator,
  computeExtensionConfigDiff,
  createUnavailableDelegationSessionBridge,
  type ExtensionConfigReloadOutcome,
  type ServiceExtension,
  type ServiceExtensionContext,
} from "../extension-activator.js";

const baseConfig = loadConfig({ den: { coreUrl: "http://den-srv:3030" } });
const adminChangedConfig = loadConfig({
  den: { coreUrl: "http://den-srv:3030" },
  admin: { enabled: false, port: 9240 },
});
const denChangedConfig = loadConfig({ den: { coreUrl: "http://den-alt:3030" } });

describe("targeted extension config reload", () => {
  it("maps changed config keys to interested extension ids", () => {
    const diff = computeExtensionConfigDiff(baseConfig, adminChangedConfig, [
      { extensionId: "admin-extension", configKeys: new Set(["admin"]), reloadable: true },
      { extensionId: "den-extension", configKeys: new Set(["den.coreUrl"]), reloadable: true },
      { extensionId: "runtime-extension", configKeys: new Set(["runtime.responseMode"]), reloadable: true },
    ]);

    expect([...diff.changedKeys].sort()).toEqual(["admin.port"]);
    expect([...diff.affectedExtensionIds]).toEqual(["admin-extension"]);
    expect(diff.nonReloadableKeys).toEqual([]);
  });

  it("reactivates only affected extensions while preserving existing service bridges", async () => {
    const logger = new FakeLogger();
    const bridge = createUnavailableDelegationSessionBridge();
    const lifecycle: string[] = [];
    const contexts: ServiceExtensionContext[] = [];
    const adminExtension = recordingExtension("admin-extension", ["admin"], lifecycle, contexts);
    const denExtension = recordingExtension("den-extension", ["den.coreUrl"], lifecycle, contexts);
    const activator = new ExtensionActivator({
      extensions: [adminExtension, denExtension],
      context: createContext(baseConfig, logger, bridge),
    });

    await activator.activateAll();
    const outcome = await activator.reloadConfig(adminChangedConfig);

    expect(outcome).toEqual<ExtensionConfigReloadOutcome>({
      changedKeys: ["admin.port"],
      affectedExtensionIds: ["admin-extension"],
      nonReloadableKeys: [],
      reactivatedExtensionIds: ["admin-extension"],
      skippedExtensionIds: ["den-extension"],
      status: "reloaded",
      warnings: [],
    });
    expect(lifecycle).toEqual([
      "activate:admin-extension:http://den-srv:3030:9237",
      "activate:den-extension:http://den-srv:3030:9237",
      "deactivate:admin-extension",
      "activate:admin-extension:http://den-srv:3030:9240",
    ]);
    expect(contexts.at(-1)?.delegationSessions).toBe(bridge);
    expect(logger.entries.some((entry) => entry.message === "extension.config_reload.completed")).toBe(true);
  });

  it("fails closed when reactivation fails and keeps the previous active extension", async () => {
    const lifecycle: string[] = [];
    const extension = failingOnReloadExtension("admin-extension", ["admin"], lifecycle);
    const activator = new ExtensionActivator({
      extensions: [extension],
      context: createContext(baseConfig, new FakeLogger(), createUnavailableDelegationSessionBridge()),
    });

    await activator.activateAll();
    await expect(activator.reloadConfig(adminChangedConfig)).rejects.toMatchObject({
      name: "ExtensionConfigReloadError",
      extensionId: "admin-extension",
    });

    expect(lifecycle).toEqual([
      "activate:admin-extension:9237",
      "deactivate:admin-extension",
      "activate:admin-extension:9237",
    ]);
  });

  it("rejects non-reloadable changed keys before deactivating extensions", async () => {
    const lifecycle: string[] = [];
    const extension = recordingExtension("den-extension", ["den.coreUrl"], lifecycle, []);
    const activator = new ExtensionActivator({
      extensions: [extension],
      context: createContext(baseConfig, new FakeLogger(), createUnavailableDelegationSessionBridge()),
      nonReloadableConfigKeys: ["den.coreUrl"],
    });

    await activator.activateAll();
    const outcome = await activator.reloadConfig(denChangedConfig);

    expect(outcome.status).toBe("blocked");
    expect(outcome.nonReloadableKeys).toEqual(["den.coreUrl"]);
    expect(lifecycle).toEqual(["activate:den-extension:http://den-srv:3030:9237"]);
  });
});

function createContext(
  config: GatewayConfig,
  logger: FakeLogger,
  delegationSessions: ServiceExtensionContext["delegationSessions"],
): ServiceExtensionContext {
  return {
    config,
    hookRegistry: new InMemoryHookRegistry(logger),
    eventBus: new FakeEventBus(),
    logger,
    delegationSessions,
  };
}

function recordingExtension(
  id: string,
  keys: readonly string[],
  lifecycle: string[],
  contexts: ServiceExtensionContext[],
): ServiceExtension {
  return {
    id,
    configInterests: new Set(keys),
    activate(context: ServiceExtensionContext) {
      contexts.push(context);
      lifecycle.push(`activate:${id}:${context.config.den.coreUrl}:${String(context.config.admin.port)}`);
      return Promise.resolve();
    },
    deactivate() {
      lifecycle.push(`deactivate:${id}`);
      return Promise.resolve();
    },
  };
}

function failingOnReloadExtension(
  id: string,
  keys: readonly string[],
  lifecycle: string[],
): ServiceExtension {
  let activationCount = 0;
  return {
    id,
    configInterests: new Set(keys),
    activate(context: ServiceExtensionContext) {
      activationCount += 1;
      if (activationCount === 2) {
        return Promise.reject(new Error("new config rejected by extension"));
      }
      lifecycle.push(`activate:${id}:${String(context.config.admin.port)}`);
      return Promise.resolve();
    },
    deactivate() {
      lifecycle.push(`deactivate:${id}`);
      return Promise.resolve();
    },
  };
}
