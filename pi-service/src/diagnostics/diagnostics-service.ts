/** Runtime-local diagnostics projection service. */
import type { DenAssignmentReader, DenAssignmentStatus } from "../persistence/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { SessionRecord } from "../sessions/types.js";
import type {
  DiagnosticChannelBindingProjection,
  DiagnosticClassification,
  DiagnosticClassificationKind,
  DiagnosticContextPressure,
  DiagnosticEventJournal,
  DiagnosticEventRecord,
  DiagnosticSessionProjection,
  DiagnosticStatusReader,
  DiagnosticsOverview,
  RuntimeHealthReader,
} from "./types.js";

export interface DiagnosticsServiceDeps {
  readonly sessionStore: SessionStore;
  readonly runtimeHealthReader: RuntimeHealthReader;
  readonly eventJournal: DiagnosticEventJournal;
  readonly denCoreStatusReader: DiagnosticStatusReader;
  readonly denChannelsStatusReader: DiagnosticStatusReader;
  readonly mcpStatusReader: DiagnosticStatusReader;
  readonly denAssignmentReader: DenAssignmentReader;
  readonly startedAt: string;
  readonly clock?: () => string;
  readonly version?: string;
}

/** Builds read-only diagnostics from local runtime state plus Den readback. */
export class DiagnosticsService {
  readonly #deps: DiagnosticsServiceDeps;
  readonly #clock: () => string;

  constructor(deps: DiagnosticsServiceDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
  }

  async projectOverview(): Promise<DiagnosticsOverview> {
    const [denCore, denChannels, mcp, sessions] = await Promise.all([
      this.#deps.denCoreStatusReader.readStatus(),
      this.#deps.denChannelsStatusReader.readStatus(),
      this.#deps.mcpStatusReader.readStatus(),
      this.#readSessions(),
    ]);
    const runtimeDb = this.#deps.runtimeHealthReader.health();
    const recentEvents = this.#deps.eventJournal.recent(50);
    const assignments = await this.#readDenAssignments(sessions);
    const projectedSessions = sessions.map((session) =>
      this.#projectSession(session, assignments, recentEvents),
    );
    const counts = {
      activeSessions: sessions.filter((session) => session.state === "active").length,
      workerSessions: sessions.filter((session) => session.kind === "worker").length,
      fullSessions: sessions.filter((session) => session.kind === "full").length,
      activeAssignmentsLocal: projectedSessions.filter((session) => session.workerBinding !== null)
        .length,
      stuckWorkers: projectedSessions.filter((session) => session.localLifecycleState === "worker.stuck")
        .length,
      checkpointWaiting: projectedSessions.filter(
        (session) => session.localLifecycleState === "checkpoint.waiting",
      ).length,
      degradedFullSessions: projectedSessions.filter(
        (session) =>
          session.kind === "full" &&
          (session.recentErrorCount > 0 || session.presenceStatus === "degraded"),
      ).length,
    };
    const classification = classifyOverview({
      denCoreStatus: denCore.status,
      denChannelsStatus: denChannels.status,
      mcpStatus: mcp.status,
      runtimeDbStatus: runtimeDb.status,
      sessionClassifications: projectedSessions.map((session) => session.classification),
    });

    return {
      service: {
        status: classification.kind === "healthy" ? "ok" : "degraded",
        version: this.#deps.version ?? "development",
        uptimeSeconds: uptimeSeconds(this.#deps.startedAt, this.#clock()),
        startedAt: this.#deps.startedAt,
        drainMode: projectedSessions.some((session) => session.drainState === "active")
          ? "active"
          : "inactive",
      },
      classification,
      denCore,
      denChannels,
      mcp,
      runtimeDb,
      counts,
      sessions: projectedSessions,
      recentEvents,
    };
  }

  async #readSessions(): Promise<SessionRecord[]> {
    const [active, idle] = await Promise.all([
      this.#deps.sessionStore.findByState("active"),
      this.#deps.sessionStore.findByState("idle"),
    ]);
    return [...active, ...idle];
  }

  async #readDenAssignments(sessions: readonly SessionRecord[]): Promise<Map<string, DenAssignmentStatus>> {
    const ids = sessions
      .map((session) => session.workerBinding?.assignmentId)
      .filter((id): id is string => id !== undefined);
    if (ids.length === 0) return new Map();
    const statuses = await this.#deps.denAssignmentReader.checkAssignments([...new Set(ids)]);
    return new Map(statuses.map((status) => [status.assignmentId, status]));
  }

  #projectSession(
    session: SessionRecord,
    assignments: ReadonlyMap<string, DenAssignmentStatus>,
    recentEvents: readonly DiagnosticEventRecord[],
  ): DiagnosticSessionProjection {
    const sessionEvents = findSessionEvents(session, recentEvents);
    const lastEvent = sessionEvents.at(-1) ?? null;
    const denAssignment = session.workerBinding
      ? assignments.get(session.workerBinding.assignmentId) ?? null
      : null;
    const contextPressure = findContextPressure(session.id, sessionEvents);
    const recentErrorCount = countRecentErrors(session.id, sessionEvents);
    const classification = classifySession(session, denAssignment, sessionEvents);
    const presenceStatus = findPresenceStatus(session, sessionEvents);

    return {
      sessionId: session.id,
      profileId: session.profileId,
      instanceId: session.instanceId,
      kind: session.kind,
      sessionState: session.state,
      messageCount: session.messageCount,
      channelBindings: session.channelBindings,
      channelBindingDetails: projectChannelBindingDetails(session),
      workerBinding: session.workerBinding,
      denAssignment,
      localLifecycleState: lastEvent?.event ?? "unknown",
      lastActivityAt: session.lastActiveAt,
      lastGatewayEvent: lastEvent?.event ?? null,
      contextPressure,
      drainState: findDrainState(session.id, sessionEvents),
      recentErrorCount,
      presenceStatus,
      classification,
      evidenceRefs: evidenceRefs(session, denAssignment, sessionEvents),
    };
  }
}

interface OverviewClassificationInput {
  readonly denCoreStatus: string;
  readonly denChannelsStatus: string;
  readonly mcpStatus: string;
  readonly runtimeDbStatus: string;
  readonly sessionClassifications: readonly DiagnosticClassificationKind[];
}

function classifyOverview(input: OverviewClassificationInput): DiagnosticClassification {
  if (input.denCoreStatus === "unreachable") {
    return { kind: "den_core_unreachable", summary: "Den Core is unreachable; Den remains authoritative." };
  }
  if (input.denChannelsStatus === "unreachable") {
    return { kind: "den_channels_unreachable", summary: "Den Channels is unreachable." };
  }
  if (input.mcpStatus === "unreachable") {
    return { kind: "mcp_unreachable", summary: "Den MCP is unreachable." };
  }
  if (input.sessionClassifications.includes("workflow_disagreement")) {
    return { kind: "workflow_disagreement", summary: "Local runtime and Den assignment state disagree." };
  }
  if (input.runtimeDbStatus === "failed" || input.sessionClassifications.includes("pi_crew_local")) {
    return { kind: "pi_crew_local", summary: "Local pi-crew runtime evidence requires attention." };
  }
  if (input.sessionClassifications.includes("unknown")) {
    return { kind: "unknown", summary: "Diagnostics have insufficient evidence." };
  }
  return { kind: "healthy", summary: "Local runtime projection agrees with reachable Den services." };
}

function classifySession(
  session: SessionRecord,
  denAssignment: DenAssignmentStatus | null,
  events: readonly DiagnosticEventRecord[],
): DiagnosticClassificationKind {
  if (session.kind === "worker" && session.state === "active" && denAssignment?.isActive === false) {
    return "workflow_disagreement";
  }
  if (events.some((event) => event.event === "worker.stuck")) return "pi_crew_local";
  if (session.kind === "worker" && denAssignment === null) return "unknown";
  // DESIGN: Full-agent sessions with recent turn errors or degraded presence
  // are classified as pi_crew_local so operators can see them in diagnostics.
  // Rationale: these are local runtime issues that need operator attention.
  if (session.kind === "full" && countRecentErrors(session.id, events) > 0) {
    return "pi_crew_local";
  }
  if (session.kind === "full" && findPresenceStatus(session, events) === "degraded") {
    return "pi_crew_local";
  }
  return "healthy";
}

function findSessionEvents(
  session: SessionRecord,
  events: readonly DiagnosticEventRecord[],
): DiagnosticEventRecord[] {
  return events.filter((event) => eventMatchesSession(event, session));
}

function eventMatchesSession(event: DiagnosticEventRecord, session: SessionRecord): boolean {
  const payload = asRecord(event.payload);
  if (payload === null) return false;
  if (payload.sessionId === session.id) return true;
  const binding = session.workerBinding;
  if (binding === null) return false;
  return payload.assignmentId === binding.assignmentId || String(payload.assignmentId) === binding.assignmentId;
}

function findContextPressure(
  sessionId: string,
  events: readonly DiagnosticEventRecord[],
): DiagnosticContextPressure | null {
  const pressure = findLastEvent(events, (event) => event.event === "context.pressure");
  if (!pressure) return null;
  const payload = asRecord(pressure.payload);
  if (payload?.sessionId !== sessionId) return null;
  if (typeof payload.usedTokens !== "number" || typeof payload.maxTokens !== "number") return null;
  return { usedTokens: payload.usedTokens, maxTokens: payload.maxTokens };
}

function findDrainState(
  sessionId: string,
  events: readonly DiagnosticEventRecord[],
): "active" | "inactive" | "unknown" {
  const drain = findLastEvent(
    events,
    (event) => event.event === "drain.activated" || event.event === "drain.deactivated",
  );
  if (!drain) return "unknown";
  const payload = asRecord(drain.payload);
  if (payload?.sessionId !== sessionId) return "unknown";
  return drain.event === "drain.activated" ? "active" : "inactive";
}

function findLastEvent(
  events: readonly DiagnosticEventRecord[],
  predicate: (event: DiagnosticEventRecord) => boolean,
): DiagnosticEventRecord | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && predicate(event)) return event;
  }
  return null;
}

function evidenceRefs(
  session: SessionRecord,
  denAssignment: DenAssignmentStatus | null,
  events: readonly DiagnosticEventRecord[],
): string[] {
  const refs: string[] = [];
  if (events.some((event) => event.event === "worker.stuck") && session.workerBinding) {
    refs.push(`worker.stuck:${session.workerBinding.assignmentId}`);
  }
  if (denAssignment?.isActive === false) {
    refs.push(`den.assignment.${denAssignment.terminalState ?? "terminal"}:${denAssignment.assignmentId}`);
  }
  return refs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function uptimeSeconds(startedAt: string, current: string): number {
  const elapsed = Date.parse(current) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.floor(elapsed / 1000);
}

// ── FullAgent diagnostics helpers ────────────────────────

function countRecentErrors(sessionId: string, events: readonly DiagnosticEventRecord[]): number {
  return events.filter(
    (event) =>
      event.event === "turn.errored" &&
      asRecord(event.payload)?.sessionId === sessionId,
  ).length;
}

function findPresenceStatus(
  session: SessionRecord,
  events: readonly DiagnosticEventRecord[],
): "active" | "idle" | "degraded" | "offline" | "unknown" {
  // DESIGN: Derive presence status from session state and recent presence events.
  // Rationale: Full-agent sessions need a quick health signal in diagnostics
  // without requiring a separate presence query.
  if (session.kind !== "full") return "unknown";
  if (session.state === "archived") return "offline";
  if (session.state === "idle") return "idle";

  // Look for the most recent session.presence event for this session
  const presenceEvent = findLastEvent(
    events,
    (event) =>
      event.event === "session.presence" &&
      asRecord(event.payload)?.sessionId === session.id,
  );
  if (presenceEvent !== null) {
    const payload = asRecord(presenceEvent.payload);
    const status = payload?.subscriptionStatus;
    if (status === "degraded") return "degraded";
    if (status === "active") return "active";
    if (status === "idle") return "idle";
  }
  // No presence event found — if the session is active with an instance, assume active
  if (session.instanceId !== null) return "active";
  return "unknown";
}

function projectChannelBindingDetails(
  session: SessionRecord,
): DiagnosticChannelBindingProjection[] {
  return session.channelBindings.map((binding): DiagnosticChannelBindingProjection => {
    if (typeof binding === "string") {
      return { providerId: "legacy", channelId: binding };
    }
    const record = binding;
    return {
      providerId: record.providerId,
      channelId: record.channelId,
      memberIdentity: record.memberIdentity,
      profileIdentity: record.profileIdentity,
      memberRole: record.memberRole,
      subscriptionIdentity: record.subscriptionIdentity,
      sessionOwnerId: record.sessionOwnerId,
    };
  });
}
