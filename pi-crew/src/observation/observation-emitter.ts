/**
 * Bridges pi-crew EventBus lifecycle events to the Den Observation service
 * via ObservationClient.
 *
 * Subscribes to a curated set of EventBus events and emits typed
 * agent_activity.v1 payloads. Designed to be wired into routing-assembly.ts
 * at Crew startup.
 *
 * @module pi-crew/observation/observation-emitter
 */

import type {
  EventBus,
  Logger,
  GatewayEvent,
} from "@pi-crew/core";
import { ObservationClient, type ObservationEvent, type AgentActivityPayload } from "./observation-client.js";

// ── Helper ────────────────────────────────────────────────────

function makePayload(
  summary: string,
  severity: AgentActivityPayload["severity"],
  visibility: AgentActivityPayload["visibility"],
  surface: string,
  overrides?: Partial<AgentActivityPayload>,
): AgentActivityPayload {
  return {
    kind: "agent_activity.v1",
    schemaVersion: 1,
    summary,
    severity,
    visibility,
    adapter: "pi-crew",
    surface,
    ...overrides,
  };
}

/**
 * Build an ObservationEvent from common pi-crew identity fields.
 */
function makeEvent(
  sourceDomain: ObservationEvent["sourceDomain"],
  eventType: string,
  profile: string,
  instanceId: string | undefined,
  sessionKey: string | undefined,
  payload: AgentActivityPayload,
): ObservationEvent {
  const identity: ObservationEvent["agentIdentity"] = {
    profile,
    instanceId: instanceId ?? profile,
    ...(sessionKey !== undefined ? { sessionKey } : {}),
  };
  return {
    sourceDomain,
    eventType,
    agentIdentity: identity,
    payload,
  };
}

// ── Emitter ───────────────────────────────────────────────────

export class ObservationEmitter {
  readonly #client: ObservationClient;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #defaultProfile: string;
  readonly #defaultInstanceId: string;
  readonly #unsubscribers: (() => void)[] = [];

  constructor(
    client: ObservationClient,
    eventBus: EventBus,
    logger: Logger,
    defaultProfile: string,
    defaultInstanceId: string,
  ) {
    this.#client = client;
    this.#eventBus = eventBus;
    this.#logger = logger;
    this.#defaultProfile = defaultProfile;
    this.#defaultInstanceId = defaultInstanceId;
  }

  /**
   * Subscribe to EventBus lifecycle events. Call once at startup.
   * Returns an unsubscribe function that tears down all subscriptions.
   */
  start(): void {
    this.#logger.info("Observation emitter starting", {
      profile: this.#defaultProfile,
      instanceId: this.#defaultInstanceId,
    });

    // ── Session lifecycle ──────────────────────────────────────
    this.#on("session.presence", (p) => {
      this.#client.post(
        sessionPresenceToObservation(p, this.#defaultProfile, this.#defaultInstanceId),
      );
    });

    this.#on("session.reset", (p) => {
      this.#client.post(
        makeEvent(
          "runtime",
          "agent_session_stopped",
          this.#defaultProfile,
          undefined,
          p.sessionId,
          makePayload(
            `Session reset at user request (${p.reason ?? "unknown"})`,
            "info",
            "agent",
            "runtime",
            {
              sessionKey: p.sessionId,
            },
          ),
        ),
      );
    });

    // ── Worker assignment lifecycle ────────────────────────────
    this.#on("assignment.claimed", (p) => {
      this.#client.post(
        makeEvent(
          "runtime",
          "work_started",
          p.workerIdentity,
          undefined,
          undefined,
          makePayload(
            `Worker claimed assignment ${p.assignmentId} (task ${p.taskId})`,
            "info",
            "task",
            "worker",
            {
              workRef: {
                taskId: p.taskId,
                assignmentId: String(p.assignmentId),
              },
            },
          ),
        ),
      );
    });

    this.#on("completion.posted", (p) => {
      const isSuccess = p.status === "completed" || p.status === "success";
      this.#client.post(
        makeEvent(
          "runtime",
          isSuccess ? "work_completed" : "work_failed",
          p.assignmentId,
          undefined,
          undefined,
          makePayload(
            `Worker posted ${p.status} completion (task ${p.taskId})`,
            isSuccess ? "success" : "warning",
            "task",
            "worker",
            {
              workRef: {
                taskId: Number(p.taskId),
                assignmentId: p.assignmentId,
                runId: p.runId,
              },
              reasonCode: isSuccess ? undefined : p.status,
            },
          ),
        ),
      );
    });

    this.#on("assignment.released", (p) => {
      this.#client.post(
        makeEvent(
          "runtime",
          "work_completed",
          p.workerIdentity,
          undefined,
          undefined,
          makePayload(
            `Worker released assignment (${p.reason})`,
            "info",
            "agent",
            "worker",
            {
              reasonCode: p.reason,
            },
          ),
        ),
      );
    });

    this.#on("checkpoint.waiting", () => {
      // Omitted — checkpoint events are too frequent for the current
      // observation contract's coarseness threshold. Revisit when needed.
    });

    // ── Delegation lifecycle ───────────────────────────────────
    this.#on("delegation.spawned", (p) => {
      this.#client.post(
        makeEvent(
          "runtime",
          "work_started",
          p.childSessionId,
          undefined,
          p.childSessionId,
          makePayload(
            `Delegated child started: ${p.task.slice(0, 100)}`,
            "info",
            "task",
            "worker",
            {
              workRef: {
                projectId: p.lineage?.rootSessionId,
                assignmentId: p.assignmentId,
                runId: p.runId,
              },
              sessionKey: p.childSessionId,
            },
          ),
        ),
      );
    });

    this.#on("delegation.completed", (p) => {
      const isSuccess = p.result.outcome === "success";
      this.#client.post(
        makeEvent(
          "runtime",
          isSuccess ? "work_completed" : "work_failed",
          p.childSessionId,
          undefined,
          p.childSessionId,
          makePayload(
            `Delegated child ${p.result.outcome}: ${p.result.summary.slice(0, 120)}`,
            isSuccess ? "success" : "warning",
            "task",
            "worker",
            {
              workRef: {
                assignmentId: p.assignmentId,
                runId: p.runId,
              },
              sessionKey: p.childSessionId,
              reasonCode: isSuccess ? undefined : p.result.outcome,
            },
          ),
        ),
      );
    });

    this.#on("delegation.timeout", (p) => {
      this.#client.post(
        makeEvent(
          "runtime",
          "work_failed",
          p.childSessionId,
          undefined,
          p.childSessionId,
          makePayload(
            `Delegated child timed out after ${p.elapsedMs}ms (limit ${p.timeoutMs}ms)`,
            "warning",
            "agent",
            "worker",
            {
              workRef: {
                assignmentId: p.assignmentId,
                runId: p.runId,
              },
              sessionKey: p.childSessionId,
              reasonCode: "timeout",
            },
          ),
        ),
      );
    });

    this.#on("delegation.killed", (p) => {
      this.#client.post(
        makeEvent(
          "runtime",
          "work_failed",
          p.childSessionId,
          undefined,
          p.childSessionId,
          makePayload(
            `Delegated child killed: ${p.reason}`,
            "warning",
            "agent",
            "worker",
            {
              workRef: {
                assignmentId: p.assignmentId,
                runId: p.runId,
              },
              sessionKey: p.childSessionId,
              reasonCode: "killed",
            },
          ),
        ),
      );
    });

    // ── Gateway lifecycle ──────────────────────────────────────
    this.#on("gateway.shutdown", (p) => {
      this.#client.post(
        makeEvent(
          "runtime",
          "agent_session_stopped",
          this.#defaultProfile,
          this.#defaultInstanceId,
          undefined,
          makePayload(
            `Gateway stopped: ${p.reason}`,
            "info",
            "agent",
            "runtime",
          ),
        ),
      );
    });

    this.#logger.info("Observation emitter subscribed to lifecycle events");
  }

  /**
   * Expose the client for direct event posting (e.g. startup/shutdown).
   */
  get client(): ObservationClient {
    return this.#client;
  }

  /** Tear down all EventBus subscriptions. */
  dispose(): void {
    for (const unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers.length = 0;
    this.#logger.info("Observation emitter disposed");
  }

  #on<E extends GatewayEvent["event"]>(
    event: E,
    handler: (payload: any) => void,
  ): void {
    this.#unsubscribers.push(
      this.#eventBus.on(event, handler as any),
    );
  }
}

// ── Session presence mapping ──────────────────────────────────

function sessionPresenceToObservation(
  payload: {
    readonly sessionId: string;
    readonly profileId: string;
    readonly agentInstanceId: string | null;
    readonly reason: string;
  },
  defaultProfile: string,
  defaultInstanceId: string,
): ObservationEvent {
  const profile = payload.profileId || defaultProfile;
  const instanceId = payload.agentInstanceId ?? defaultInstanceId;
  const reason = payload.reason;

  switch (reason) {
    case "created":
      return makeEvent(
        "runtime",
        "agent_session_started",
        profile,
        instanceId,
        payload.sessionId,
        makePayload(
          `Session created (${profile})`,
          "info",
          "channel",
          "runtime",
          { sessionKey: payload.sessionId },
        ),
      );
    case "rehydrated":
      return makeEvent(
        "runtime",
        "agent_session_resumed",
        profile,
        instanceId,
        payload.sessionId,
        makePayload(
          `Session rehydrated (${profile})`,
          "info",
          "channel",
          "runtime",
          { sessionKey: payload.sessionId },
        ),
      );
    case "idle_evicted":
      return makeEvent(
        "runtime",
        "agent_session_idle",
        profile,
        instanceId,
        payload.sessionId,
        makePayload(
          `Session idle evicted (${profile})`,
          "info",
          "agent",
          "runtime",
          { sessionKey: payload.sessionId, reasonCode: "idle_evicted" },
        ),
      );
    case "archived":
      return makeEvent(
        "runtime",
        "agent_session_stopped",
        profile,
        instanceId,
        payload.sessionId,
        makePayload(
          `Session archived (${profile})`,
          "info",
          "channel",
          "runtime",
          { sessionKey: payload.sessionId },
        ),
      );
    case "routed":
      // Routine routing events are too frequent; skip to reduce noise.
      // Observation is for coarse lifecycle transitions only.
      return makeEvent(
        "runtime",
        "agent_session_idle",
        profile,
        instanceId,
        payload.sessionId,
        makePayload(
          `Agent active (${profile})`,
          "info",
          "agent",
          "runtime",
          { sessionKey: payload.sessionId },
        ),
      );
    case "response_timeout":
      return makeEvent(
        "runtime",
        "agent_session_blocked",
        profile,
        instanceId,
        payload.sessionId,
        makePayload(
          `Session response timeout (${profile})`,
          "warning",
          "channel",
          "runtime",
          { sessionKey: payload.sessionId, reasonCode: "response_timeout" },
        ),
      );
    case "bound":
    case "unbound":
      return makeEvent(
        "runtime",
        "adapter_connected",
        profile,
        instanceId,
        payload.sessionId,
        makePayload(
          `Channel ${reason} (${profile})`,
          "info",
          "agent",
          "runtime",
          { surface: "channel", sessionKey: payload.sessionId },
        ),
      );
    default:
      return makeEvent(
        "runtime",
        "agent_session_idle",
        profile,
        instanceId,
        payload.sessionId,
        makePayload(
          `Session ${reason} (${profile})`,
          "info",
          "agent",
          "runtime",
          { sessionKey: payload.sessionId },
        ),
      );
  }
}
