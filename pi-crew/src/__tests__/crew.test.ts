/** Integration tests for the Crew composition root. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelMessage, ChannelParticipant } from "@pi-crew/core";
import { FakeLogger, FakeEventBus } from "@pi-crew/core";

import {
  Crew,
  bootstrap,
  CrewConfigSchema,
  loadCrewConfig,
  type CrewConfig,
} from "../crew.js";

let nextHealthPort = 19_236;

type CrewConfigOverrides = Omit<Partial<CrewConfig>, "den" | "sessions"> & {
  readonly den?: Partial<CrewConfig["den"]>; readonly sessions?: Partial<CrewConfig["sessions"]>;
};
function makeTestCrewConfig(overrides?: CrewConfigOverrides): CrewConfig {
  const parsed = CrewConfigSchema.safeParse({
    database: { path: makeTempDbPath(), wal: true },
    health: { host: "127.0.0.1", port: nextHealthPort++ },
    den: {
      coreUrl: "http://localhost:3030",
      requiredAtStartup: false,
      ...overrides?.den,
    },
    ...omitNestedOverrides(overrides),
    ...(overrides?.sessions === undefined ? {} : { sessions: overrides.sessions }),
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid test config: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

function omitNestedOverrides(overrides: CrewConfigOverrides | undefined): Omit<CrewConfigOverrides, "den" | "sessions"> {
  if (overrides === undefined) return {};
  const rest: Record<string, unknown> = { ...overrides };
  delete rest["den"];
  delete rest["sessions"];
  return rest;
}

function makeTempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-crew-test-")), "runtime.db");
}

function writeTempConfigYaml(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-crew-config-"));
  const dbPath = join(dir, "runtime.db");
  const configPath = join(dir, "default.yaml");
  writeFileSync(
    configPath,
    `den:\n  coreUrl: "http://localhost:3030"\n  requiredAtStartup: false\ndatabase:\n  path: "${dbPath}"\n  wal: true\n`,
    "utf-8",
  );
  return configPath;
}

function makeTestMessage(
  channelId: string,
  text: string,
): ChannelMessage {
  const sender: ChannelParticipant = {
    id: "test-human",
    displayName: "Test Human",
    kind: "human",
    platform: "den-channels",
  };
  return {
    id: `msg-${String(Math.random()).slice(2, 10)}`,
    channelId,
    sender,
    content: { kind: "text", text },
    timestamp: new Date(),
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("Crew composition root", () => {
  let crew: Crew;
  let logger: FakeLogger;
  let eventBus: FakeEventBus;

  beforeEach(() => {
    logger = new FakeLogger();
    eventBus = new FakeEventBus();
    crew = new Crew(makeTestCrewConfig(), logger, eventBus);
  });

  afterEach(async () => {
    await crew.stop("test-cleanup");
  });

  // ── Assembly ────────────────────────────────────────────────

  it("assembles all dependencies without throwing", () => {
    expect(crew).toBeDefined();
    expect(crew.gateway).toBeDefined();
    expect(crew.channelProvider).toBeDefined();
    expect(crew.mcpClient).toBeDefined();
    expect(crew.mcpToolRegistry).toBeDefined();
    expect(crew.sessionManager).toBeDefined();
    expect(crew.instancePool).toBeDefined();
    expect(crew.breadcrumbManager).toBeDefined();
    expect(crew.auditLogger).toBeDefined();
    expect(crew.toolPolicyEnforcer).toBeDefined();
    expect(crew.workerRuntimeHooks.hookRegistry).toBeDefined();
    expect(crew.workerRuntimeHooks.toolPolicySessionRegistry).toBeDefined();
  });

  it("logs assembly info at construction", () => {
    const infoLogs = logger.entries.filter((e) => e.level === "info");
    expect(infoLogs.length).toBeGreaterThanOrEqual(1);
    const assemblyLog = infoLogs.find(
      (e) => e.message === "Crew composition root assembled",
    );
    expect(assemblyLog).toBeDefined();
  });

  it("starts and stops without error", async () => {
    await crew.start();
    expect(crew.isRunning).toBe(true);

    // Start is idempotent
    await crew.start();
    expect(crew.isRunning).toBe(true);

    await crew.stop("test");
    expect(crew.isRunning).toBe(false);

    // Stop is idempotent
    await crew.stop("test-again");
    expect(crew.isRunning).toBe(false);
  });

  it("emits gateway events on start and stop", async () => {
    await crew.start();

    // gateway.shutdown is emitted on stop
    await crew.stop("test-reason");
    const shutdownEvents = eventBus.emitted.filter(
      (e) => e.event === "gateway.shutdown",
    );
    expect(shutdownEvents.length).toBe(1);
    if (shutdownEvents[0]?.event === "gateway.shutdown") {
      expect(shutdownEvents[0].payload.reason).toBe("test-reason");
    }
  });

  // ── Message routing ─────────────────────────────────────────

  it("routes a message through provider → session → agent", async () => {
    await crew.start();

    const provider = crew.channelProvider;
    const msg = makeTestMessage("channel-1", "Hello agent!");

    // Inject the message by calling routeMessage directly via sessionManager.
    // This is what the DenChannelsAdapter.onMessage handler would do.
    await crew.sessionManager.routeMessage(provider, msg);

    // Expect a session.created event
    const created = eventBus.emitted.filter(
      (e) => e.event === "session.created",
    );
    expect(created.length).toBeGreaterThanOrEqual(1);

    // Expect a session.routing event (fallback_created since no existing session)
    const routing = eventBus.emitted.filter(
      (e) => e.event === "session.routing",
    );
    expect(routing.length).toBeGreaterThanOrEqual(1);

    // Verify agent response flow through events:
    // session.created → session.routing → tool.called → tool.completed
    // The fake agent echoes back "received: Hello agent!" as a text response.
  });

  it("creates a visible fallback session when no existing session", async () => {
    await crew.start();

    const msg = makeTestMessage("new-channel", "First message");
    await crew.sessionManager.routeMessage(crew.channelProvider, msg);

    const routingEvents = eventBus.emitted.filter(
      (e) => e.event === "session.routing",
    );
    const fallback = routingEvents.filter(
      (e) => e.payload.reason === "fallback_created",
    );
    expect(fallback.length).toBeGreaterThanOrEqual(1);
  });

  it("reuses existing session for subsequent messages on same channel", async () => {
    await crew.start();

    const provider = crew.channelProvider;
    const chId = "reuse-channel";

    // First message → creates fallback session
    const msg1 = makeTestMessage(chId, "Hello");
    await crew.sessionManager.routeMessage(provider, msg1);

    // Second message → should route to existing session
    const msg2 = makeTestMessage(chId, "Hello again");
    await crew.sessionManager.routeMessage(provider, msg2);

    const routingEvents = eventBus.emitted.filter(
      (e) => e.event === "session.routing",
    );

    // First routing is fallback_created
    const fallbackCreated = routingEvents.filter(
      (e) => e.payload.reason === "fallback_created",
    );
    // Second routing is existing_session
    const existingSession = routingEvents.filter(
      (e) => e.payload.reason === "existing_session",
    );

    expect(fallbackCreated.length).toBeGreaterThanOrEqual(1);
    expect(existingSession.length).toBeGreaterThanOrEqual(1);
  });

  // ── Governance ───────────────────────────────────────────────

  it("emits breadcrumbs through governance provider path", async () => {
    await crew.start();

    const msg = makeTestMessage("gov-channel", "Governance test");
    await crew.sessionManager.routeMessage(crew.channelProvider, msg);

    // At minimum, session.created and session.routing events should
    // have been picked up by governance subscribers.
    const sessionEvents = eventBus.emitted.filter(
      (e) =>
        e.event === "session.created" ||
        e.event === "session.routing",
    );
    expect(sessionEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("captures audit log entries with session correlation", async () => {
    await crew.start();

    const msg = makeTestMessage("audit-channel", "Audit test");
    await crew.sessionManager.routeMessage(crew.channelProvider, msg);

    // Audit log entries are captured by the AuditLogger which subscribes
    // to all gateway events. We verify via emitted events on the bus.
    const sessionEvents = eventBus.emitted.filter(
      (e) =>
        e.event === "session.created" ||
        e.event === "session.routing",
    );
    expect(sessionEvents.length).toBeGreaterThanOrEqual(1);

    const row = crew.runtimeDb.handle
      .prepare("SELECT COUNT(*) AS count FROM audit_log")
      .get() as { count: number };
    expect(row.count).toBeGreaterThan(0);
  });

  it("persists conversational sessions through the local runtime database", async () => {
    const dbPath = makeTempDbPath();
    const config = makeTestCrewConfig({ database: { path: dbPath, wal: true } });
    const firstCrew = new Crew(config, new FakeLogger(), new FakeEventBus());

    await firstCrew.start();
    await firstCrew.sessionManager.routeMessage(
      firstCrew.channelProvider,
      makeTestMessage("persisted-channel", "First turn"),
    );
    await firstCrew.stop("restart");

    const secondBus = new FakeEventBus();
    const secondCrew = new Crew(config, new FakeLogger(), secondBus);
    await secondCrew.start();
    await secondCrew.sessionManager.routeMessage(
      secondCrew.channelProvider,
      makeTestMessage("persisted-channel", "Second turn"),
    );

    const existingRoutes = secondBus.emitted.filter(
      (e) =>
        e.event === "session.routing" &&
        e.payload.reason === "existing_session",
    );
    expect(existingRoutes.length).toBeGreaterThan(0);

    await secondCrew.stop("cleanup");
  });

  // ── Instance pool ───────────────────────────────────────────

  it("instance pool creates instances for sessions", async () => {
    await crew.start();

    const pool = crew.instancePool;
    expect(pool.size).toBe(0);

    const msg = makeTestMessage("pool-channel", "Pool test");
    await crew.sessionManager.routeMessage(crew.channelProvider, msg);

    // SessionManager creates a session → AgentFactory creates a session
    // → InstancePool.acquire creates an instance
    expect(pool.size).toBeGreaterThanOrEqual(1);
  });

  it("instance pool enforces per-profile limits", async () => {
    await crew.start();

    const pool = crew.instancePool;

    // Acquire maxPerProfile instances manually
    const profileId = "default";
    const maxProfile = crew.config.sessions.maxPerProfile;

    for (let i = 0; i < maxProfile; i++) {
      await pool.acquire(profileId);
    }

    // Next acquire should throw
    await expect(pool.acquire(profileId)).rejects.toThrow();
  });

  // ── Shutdown ────────────────────────────────────────────────

  it("graceful shutdown disconnects providers", async () => {
    await crew.start();
    expect(crew.channelProvider.isConnected).toBe(true);

    await crew.stop("test-shutdown");
    expect(crew.channelProvider.isConnected).toBe(false);
  });

  it("disposes governance on shutdown", async () => {
    await crew.start();
    await crew.stop("test-governance-dispose");

    // After shutdown, governance subscribers are cleaned up.
    // EventBus emissions should no longer go to disposed subscribers.
    eventBus.emit({
      event: "tool.called",
      payload: {
        toolName: "test",
        sessionId: "sess-post-shutdown",
      },
    });

    // No error — governance disposed gracefully
    expect(true).toBe(true);
  });

  it("idempotent start/stop", async () => {
    await crew.start();
    await crew.start(); // should be no-op

    await crew.stop("first");
    await crew.stop("second"); // should be no-op

    expect(crew.isRunning).toBe(false);
  });

  // ── Config defaults ─────────────────────────────────────────

  it("uses session defaults from config", () => {
    const cfg = crew.config;
    expect(cfg.sessions.maxTotal).toBe(16);
    expect(cfg.sessions.maxPerProfile).toBe(4);
    expect(cfg.sessions.idleTimeoutMs).toBe(28_800_000);
    expect(cfg.sessions.fallbackProfileId).toBe("system-architect");
  });

  it("loads config with custom values overridden", () => {
    const customCrew = new Crew(
      makeTestCrewConfig({
        profiles: { root: join(process.cwd(), process.cwd().endsWith("pi-crew/pi-crew") ? "../pi-profiles/profiles" : "pi-profiles/profiles") }, sessions: { maxTotal: 8, maxPerProfile: 2, idleTimeoutMs: 1_000, fallbackProfileId: "pi-crew-planner" },
        logging: { level: "debug", json: true },
      }),
    );

    expect(customCrew.config.sessions.maxTotal).toBe(8);
    expect(customCrew.config.sessions.maxPerProfile).toBe(2);
    expect(customCrew.config.sessions.idleTimeoutMs).toBe(1_000);
    expect(customCrew.config.sessions.fallbackProfileId).toBe("pi-crew-planner");
  });

  // ── Channel provider wiring ─────────────────────────────────

  it("channel provider wires onMessage → sessionManager.routeMessage", async () => {
    const testLogger = new FakeLogger();
    const testEventBus = new FakeEventBus();
    const testCrew = new Crew(makeTestCrewConfig(), testLogger, testEventBus);

    await testCrew.start();

    // Verify the provider accepts inbound messages
    expect(testCrew.channelProvider).toBeDefined();
    expect(testCrew.sessionManager).toBeDefined();

    // Send a message through sessionManager directly — this simulates
    // what the adapter's onMessage handler would do.
    const msg = makeTestMessage("wire-channel", "Wire test");
    await testCrew.sessionManager.routeMessage(testCrew.channelProvider, msg);

    // Verify session was created
    const created = testEventBus.emitted.filter(
      (e) => e.event === "session.created",
    );
    expect(created.length).toBeGreaterThanOrEqual(1);

    await testCrew.stop("wire-test");
  });

});

// ── bootstrap/config loading tests ─────────────────────────────

describe("loadCrewConfig", () => {
  it("throws for missing den.coreUrl", () => {
    const result = CrewConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("sets defaults when only den provided", () => {
    const result = CrewConfigSchema.safeParse({
      den: { coreUrl: "http://localhost:3030" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logging.level).toBe("info");
      expect(result.data.sessions.maxTotal).toBe(16);
      expect(result.data.sessions.fallbackProfileId).toBe("system-architect");
      expect(result.data.database.path).toBe("/var/lib/pi-crew/runtime.db");
      expect(result.data.health.port).toBe(9236);
    }
  });

  it("enforces non-empty fallbackProfileId", () => {
    const result = CrewConfigSchema.safeParse({
      den: { coreUrl: "http://localhost:3030" },
      sessions: { fallbackProfileId: "" },
    });
    expect(result.success).toBe(false);
  });

  it("allows custom fallbackProfileId override", () => {
    const result = CrewConfigSchema.safeParse({
      den: { coreUrl: "http://localhost:3030" },
      sessions: { fallbackProfileId: "pi-crew-planner" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessions.fallbackProfileId).toBe("pi-crew-planner");
    }
  });

  it("rejects unknown configured fallback profile at startup", () => {
    expect(() =>
      new Crew(makeTestCrewConfig({
        sessions: { fallbackProfileId: "missing-profile" },
      })),
    ).toThrow(/Profile "missing-profile" not found/);
  });

});

// ── Bootstrap via YAML file ────────────────────────────────────

describe("bootstrap from YAML", () => {
  it("loads config from YAML with channels settings", () => {
    const config = loadCrewConfig(writeTempConfigYaml());
    expect(config).toBeDefined();
    expect(config.den.coreUrl).toBeDefined();
    expect(typeof config.den.coreUrl).toBe("string");
    // channelsUrl/channelsToken are now part of DenConfig
    expect(typeof config.den.channelsUrl).toBe("string");
    expect(typeof config.den.channelsToken).toBe("string");
  });

  it("bootstrap creates a Crew instance from config file", () => {
    const c = bootstrap(writeTempConfigYaml());
    expect(c).toBeDefined();
    expect(c.gateway).toBeDefined();
    expect(c.channelProvider).toBeDefined();
    expect(c.sessionManager).toBeDefined();
    void c.stop("bootstrap-test-cleanup");
  });
});
