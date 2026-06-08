/** Runtime-local metrics collection and Prometheus exposition. */
import type { EventBus } from "@pi-crew/core";
import type { DiagnosticsOverview } from "./types.js";

export interface RuntimeMetricsSnapshot {
  readonly startedAt: string;
  readonly uptimeSeconds: number;
  readonly receivedTotal: number;
  readonly assignmentsClaimedTotal: number;
  readonly assignmentsReleasedTotal: number;
  readonly completionsPostedTotal: number;
  readonly completionFailuresTotal: number;
  readonly cursorLagEvents: number;
  readonly lifecycleWriteFailuresTotal: number;
}

interface RuntimeMetricsCollectorOptions {
  readonly startedAt: string;
  readonly clock?: () => string;
}

interface RuntimeMetricsCounters {
  receivedTotal: number;
  assignmentsClaimedTotal: number;
  assignmentsReleasedTotal: number;
  completionsPostedTotal: number;
  completionFailuresTotal: number;
  cursorLagEvents: number;
  lifecycleWriteFailuresTotal: number;
}

const METRIC_NAMES = {
  uptime: "pi_crew_runtime_uptime_seconds",
  activeSessions: "pi_crew_active_sessions",
  activeWorkerAssignments: "pi_crew_active_worker_assignments",
  receivedTotal: "pi_crew_received_total",
  assignmentsClaimedTotal: "pi_crew_assignments_claimed_total",
  assignmentsReleasedTotal: "pi_crew_assignments_released_total",
  completionsPostedTotal: "pi_crew_completions_posted_total",
  completionFailuresTotal: "pi_crew_completion_failures_total",
  cursorLag: "pi_crew_cursor_lag_events",
  lifecycleWriteFailures: "pi_crew_lifecycle_write_failures_total",
  configVersion: "pi_crew_runtime_config_version_info",
} as const;

/** Collects runtime-local counters from GatewayEvents without storing workflow payloads. */
export class RuntimeMetricsCollector {
  readonly #startedAt: string;
  readonly #clock: () => string;
  readonly #counters: RuntimeMetricsCounters = {
    receivedTotal: 0,
    assignmentsClaimedTotal: 0,
    assignmentsReleasedTotal: 0,
    completionsPostedTotal: 0,
    completionFailuresTotal: 0,
    cursorLagEvents: 0,
    lifecycleWriteFailuresTotal: 0,
  };

  constructor(eventBus: EventBus, options: RuntimeMetricsCollectorOptions) {
    this.#startedAt = options.startedAt;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#subscribe(eventBus);
  }

  snapshot(): RuntimeMetricsSnapshot {
    return {
      startedAt: this.#startedAt,
      uptimeSeconds: uptimeSeconds(this.#startedAt, this.#clock()),
      ...this.#counters,
    };
  }

  recordCursorLag(lagEvents: number): void {
    this.#counters.cursorLagEvents = Math.max(0, Math.floor(lagEvents));
  }

  recordLifecycleWriteFailure(): void {
    this.#counters.lifecycleWriteFailuresTotal += 1;
  }

  #subscribe(eventBus: EventBus): void {
    eventBus.on("session.routing", () => {
      this.#counters.receivedTotal += 1;
    });
    eventBus.on("assignment.claimed", () => {
      this.#counters.assignmentsClaimedTotal += 1;
    });
    eventBus.on("assignment.released", () => {
      this.#counters.assignmentsReleasedTotal += 1;
    });
    eventBus.on("completion.posted", (payload) => {
      this.#counters.completionsPostedTotal += 1;
      if (!payload.accepted || payload.status !== "completed") {
        this.#counters.completionFailuresTotal += 1;
      }
    });
    eventBus.on("turn.errored", () => {
      this.#counters.completionFailuresTotal += 1;
    });
    eventBus.on("assignment.timed_out", () => {
      this.#counters.completionFailuresTotal += 1;
    });
    eventBus.on("worker.stuck", () => {
      this.#counters.completionFailuresTotal += 1;
    });
  }
}

export function renderPrometheusMetrics(
  snapshot: RuntimeMetricsSnapshot,
  overview: DiagnosticsOverview,
): string {
  const lines: string[] = [];
  appendMetric(lines, METRIC_NAMES.uptime, "Runtime process uptime in seconds.", "gauge", snapshot.uptimeSeconds);
  appendMetric(lines, METRIC_NAMES.activeSessions, "Active local pi-crew sessions.", "gauge", overview.counts.activeSessions);
  appendMetric(lines, METRIC_NAMES.activeWorkerAssignments, "Active runtime-local worker assignments.", "gauge", overview.counts.activeAssignmentsLocal);
  appendMetric(lines, METRIC_NAMES.receivedTotal, "Inbound items routed by the local runtime.", "counter", snapshot.receivedTotal);
  appendMetric(lines, METRIC_NAMES.assignmentsClaimedTotal, "Worker assignments claimed by the local runtime.", "counter", snapshot.assignmentsClaimedTotal);
  appendMetric(lines, METRIC_NAMES.assignmentsReleasedTotal, "Worker assignments released by the local runtime.", "counter", snapshot.assignmentsReleasedTotal);
  appendMetric(lines, METRIC_NAMES.completionsPostedTotal, "Completion packets posted by the local runtime.", "counter", snapshot.completionsPostedTotal);
  appendMetric(lines, METRIC_NAMES.completionFailuresTotal, "Runtime-local worker failures or failed completions.", "counter", snapshot.completionFailuresTotal);
  appendMetric(lines, METRIC_NAMES.cursorLag, "Direct-agent cursor lag measured in events.", "gauge", snapshot.cursorLagEvents);
  appendMetric(lines, METRIC_NAMES.lifecycleWriteFailures, "Lifecycle telemetry write failures observed locally.", "counter", snapshot.lifecycleWriteFailuresTotal);
  appendInfoMetric(lines, METRIC_NAMES.configVersion, "Runtime configuration version marker.", { version: overview.service.version });
  return `${lines.join("\n")}\n`;
}

function appendMetric(
  lines: string[],
  name: string,
  help: string,
  type: "counter" | "gauge",
  value: number,
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  lines.push(`${name} ${formatNumber(value)}`);
}

function appendInfoMetric(
  lines: string[],
  name: string,
  help: string,
  labels: Readonly<Record<string, string>>,
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  lines.push(`${name}{${formatLabels(labels)}} 1`);
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(value);
}

function uptimeSeconds(startedAt: string, current: string): number {
  const elapsed = Date.parse(current) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.floor(elapsed / 1000);
}
