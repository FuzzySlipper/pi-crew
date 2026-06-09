import { describe, expect, it } from "vitest";
import {
  FakeEventBus,
  FakeLogger,
  InMemoryHookRegistry,
  type ExecutionPolicy,
  type HookRegistry,
} from "@pi-crew/core";
import { loadConfig } from "../config.js";
import {
  ExtensionActivator,
  type DelegatedSessionCreateRequest,
  type DelegationSessionBridge,
  type DelegationVisibilityEvent,
  type ServiceExtension,
  type ServiceExtensionContext,
  type ServiceSessionView,
} from "../extension-activator.js";

const config = loadConfig({ den: { coreUrl: "http://den-srv:3030" } });

const policy: ExecutionPolicy = {
  policyId: "policy-parent",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["terminal"],
  deniedTools: [],
  allowedHosts: [],
  deniedHosts: [],
  maxDurationMs: 60_000,
  maxTurnDurationMs: 10_000,
  idleTimeoutMs: 5_000,
  maxIterations: 4,
  maxTokensPerTurn: 8_000,
  credentialScope: "none",
};

const parentSession: ServiceSessionView = {
  sessionId: "parent-session",
  profileId: "parent-profile",
  kind: "worker",
  state: "active",
  parentSessionId: null,
  rootSessionId: "parent-session",
};

const childSession: ServiceSessionView = {
  sessionId: "child-session",
  profileId: "child-profile",
  kind: "worker",
  state: "active",
  parentSessionId: "parent-session",
  rootSessionId: "parent-session",
};

describe("ExtensionActivator", () => {
  it("activates extensions in composition-root order and deactivates in reverse order", async () => {
    const calls: string[] = [];
    const hookRegistry = new InMemoryHookRegistry(new FakeLogger());
    const extensions = [
      createLifecycleExtension("alpha", calls, hookRegistry),
      createLifecycleExtension("beta", calls, hookRegistry),
    ];
    const activator = new ExtensionActivator({
      extensions,
      context: createContext(hookRegistry, createBridge()),
    });

    await activator.activateAll();

    expect(calls).toEqual(["activate:alpha", "activate:beta"]);

    await activator.deactivateAll();

    expect(calls).toEqual([
      "activate:alpha",
      "activate:beta",
      "deactivate:beta",
      "deactivate:alpha",
    ]);
  });

  it("lets service extensions unregister hook handlers during deactivation", async () => {
    const hookRegistry = new InMemoryHookRegistry(new FakeLogger());
    const extension = createGateExtension("session-gate");
    const activator = new ExtensionActivator({
      extensions: [extension],
      context: createContext(hookRegistry, createBridge()),
    });

    await activator.activateAll();

    const denied = await hookRegistry.fire("before_session_create", {
      profileId: "worker-profile",
      kind: "worker",
      channelBindings: [],
    });
    expect(denied).toEqual({ proceed: false, reason: "blocked by session-gate" });

    await activator.deactivateAll();

    const allowed = await hookRegistry.fire("before_session_create", {
      profileId: "worker-profile",
      kind: "worker",
      channelBindings: [],
    });
    expect(allowed).toEqual({ proceed: true });
  });

  it("passes validated service config and shared core services into extensions", async () => {
    const hookRegistry = new InMemoryHookRegistry(new FakeLogger());
    const logger = new FakeLogger();
    const eventBus = new FakeEventBus();
    const observedContexts: ServiceExtensionContext[] = [];
    const extension: ServiceExtension = {
      id: "observer",
      activate(context: ServiceExtensionContext) {
        observedContexts.push(context);
        return Promise.resolve();
      },
      deactivate() {
        return Promise.resolve();
      },
    };

    await new ExtensionActivator({
      extensions: [extension],
      context: createContext(hookRegistry, createBridge(), { logger, eventBus }),
    }).activateAll();

    const observed = observedContexts[0];
    expect(observed).toBeDefined();
    expect(observed?.config).toBe(config);
    expect(observed?.logger).toBe(logger);
    expect(observed?.eventBus).toBe(eventBus);
    expect(observed?.hookRegistry).toBe(hookRegistry);
  });

  it("exposes narrow delegation session bridge ports without concrete SessionManager", async () => {
    const operations: string[] = [];
    const bridge = createBridge(operations);
    const extension: ServiceExtension = {
      id: "delegation-consumer",
      async activate(context: ServiceExtensionContext) {
        const foundParent = await context.delegationSessions.getSession("parent-session");
        const created = await context.delegationSessions.createDelegatedSession({
          parentSessionId: "parent-session",
          profileId: "child-profile",
          policy,
          visibility: { reason: "test-spawn" },
        });
        const children = await context.delegationSessions.listChildSessions("parent-session");
        const count = await context.delegationSessions.countChildSessions("parent-session");
        const parentPolicy = await context.delegationSessions.getParentExecutionPolicy("child-session");
        await context.delegationSessions.releaseChildSession("child-session", "completed");
        await context.delegationSessions.killChildSession("child-session", "timeout");
        await context.delegationSessions.archiveChildSession("child-session", "cleanup");
        await context.delegationSessions.emitVisibilityEvent({
          sessionId: "child-session",
          eventType: "delegated.session.spawned",
          metadata: { parentSessionId: "parent-session" },
        });

        expect(foundParent).toEqual(parentSession);
        expect(created).toEqual(childSession);
        expect(children).toEqual([childSession]);
        expect(count).toBe(1);
        expect(parentPolicy).toEqual(policy);
      },
      deactivate() {
        return Promise.resolve();
      },
    };

    await new ExtensionActivator({
      extensions: [extension],
      context: createContext(new InMemoryHookRegistry(new FakeLogger()), bridge),
    }).activateAll();

    expect(operations).toEqual([
      "getSession:parent-session",
      "createDelegatedSession:parent-session->child-profile",
      "listChildSessions:parent-session",
      "countChildSessions:parent-session",
      "getParentExecutionPolicy:child-session",
      "releaseChildSession:child-session:completed",
      "killChildSession:child-session:timeout",
      "archiveChildSession:child-session:cleanup",
      "emitVisibilityEvent:delegated.session.spawned:child-session",
    ]);
  });
});

function createContext(
  hookRegistry: HookRegistry,
  delegationSessions: DelegationSessionBridge,
  overrides: Partial<Pick<ServiceExtensionContext, "logger" | "eventBus">> = {},
): ServiceExtensionContext {
  return {
    config,
    hookRegistry,
    eventBus: overrides.eventBus ?? new FakeEventBus(),
    logger: overrides.logger ?? new FakeLogger(),
    delegationSessions,
  };
}

function createLifecycleExtension(
  id: string,
  calls: string[],
  hookRegistry: HookRegistry,
): ServiceExtension {
  let unsubscribe: (() => void) | null = null;
  return {
    id,
    activate() {
      calls.push(`activate:${id}`);
      unsubscribe = hookRegistry.register("after_message_send", () => {}, { name: id });
      return Promise.resolve();
    },
    deactivate() {
      calls.push(`deactivate:${id}`);
      unsubscribe?.();
      unsubscribe = null;
      return Promise.resolve();
    },
  };
}

function createGateExtension(id: string): ServiceExtension {
  let unregister: (() => void) | null = null;
  return {
    id,
    activate(context: ServiceExtensionContext) {
      unregister = context.hookRegistry.register(
        "before_session_create",
        () => ({ proceed: false, reason: `blocked by ${id}` }),
        { name: id },
      );
      return Promise.resolve();
    },
    deactivate() {
      unregister?.();
      unregister = null;
      return Promise.resolve();
    },
  };
}

function createBridge(operations: string[] = []): DelegationSessionBridge {
  return {
    getSession(sessionId: string) {
      operations.push(`getSession:${sessionId}`);
      return Promise.resolve(sessionId === parentSession.sessionId ? parentSession : null);
    },
    createDelegatedSession(request: DelegatedSessionCreateRequest) {
      operations.push(`createDelegatedSession:${request.parentSessionId}->${request.profileId}`);
      return Promise.resolve(childSession);
    },
    listChildSessions(parentSessionId: string) {
      operations.push(`listChildSessions:${parentSessionId}`);
      return Promise.resolve([childSession]);
    },
    countChildSessions(parentSessionId: string) {
      operations.push(`countChildSessions:${parentSessionId}`);
      return Promise.resolve(1);
    },
    getParentExecutionPolicy(childSessionId: string) {
      operations.push(`getParentExecutionPolicy:${childSessionId}`);
      return Promise.resolve(policy);
    },
    releaseChildSession(childSessionId: string, reason: string) {
      operations.push(`releaseChildSession:${childSessionId}:${reason}`);
      return Promise.resolve();
    },
    killChildSession(childSessionId: string, reason: string) {
      operations.push(`killChildSession:${childSessionId}:${reason}`);
      return Promise.resolve();
    },
    archiveChildSession(childSessionId: string, reason: string) {
      operations.push(`archiveChildSession:${childSessionId}:${reason}`);
      return Promise.resolve();
    },
    emitVisibilityEvent(event: DelegationVisibilityEvent) {
      operations.push(`emitVisibilityEvent:${event.eventType}:${event.sessionId}`);
      return Promise.resolve();
    },
  };
}
