/** Typed read models for pi-service runtime diagnostics. */
import type { GatewayEvent } from "@pi-crew/core";
import type { DenAssignmentStatus } from "../persistence/types.js";
import type { ChannelBinding, WorkerBinding } from "../sessions/types.js";

export type ReachabilityStatus = "ok" | "degraded" | "unreachable";

export type DiagnosticClassificationKind =
  | "healthy"
  | "pi_crew_local"
  | "den_core_unreachable"
  | "den_channels_unreachable"
  | "mcp_unreachable"
  | "workflow_disagreement"
  | "unknown";

export interface DiagnosticClassification {
  readonly kind: DiagnosticClassificationKind;
  readonly summary: string;
}

export interface DiagnosticStatusSnapshot {
  readonly status: ReachabilityStatus;
  readonly lastOkAt: string | null;
}

export interface DiagnosticStatusReader {
  readStatus(): Promise<DiagnosticStatusSnapshot>;
}

export interface RuntimeHealthOkSnapshot {
  readonly status: "ok";
  readonly path: string;
  readonly walEnabled: boolean;
  readonly tableCount: number;
  readonly schemaVersion: number;
}

export interface RuntimeHealthFailedSnapshot {
  readonly status: "failed";
  readonly error: string;
}

export type RuntimeHealthSnapshot = RuntimeHealthOkSnapshot | RuntimeHealthFailedSnapshot;

export interface RuntimeHealthReader {
  health(): RuntimeHealthSnapshot;
}

export interface DiagnosticEventRecord {
  readonly sequence: number;
  readonly observedAt: string;
  readonly event: GatewayEvent["event"];
  readonly payload: unknown;
}

export interface DiagnosticEventJournal {
  recent(limit?: number): DiagnosticEventRecord[];
}

export interface DiagnosticCounts {
  readonly activeSessions: number;
  readonly workerSessions: number;
  readonly conversationalSessions: number;
  readonly activeAssignmentsLocal: number;
  readonly stuckWorkers: number;
  readonly checkpointWaiting: number;
}

export interface DiagnosticSessionProjection {
  readonly sessionId: string;
  readonly profileId: string;
  readonly instanceId: string | null;
  readonly kind: "conversational" | "worker";
  readonly sessionState: "active" | "idle" | "archived";
  readonly messageCount: number;
  readonly channelBindings: readonly ChannelBinding[];
  readonly workerBinding: WorkerBinding | null;
  readonly denAssignment: DenAssignmentStatus | null;
  readonly localLifecycleState: GatewayEvent["event"] | "unknown";
  readonly lastActivityAt: string;
  readonly lastGatewayEvent: GatewayEvent["event"] | null;
  readonly contextPressure: DiagnosticContextPressure | null;
  readonly drainState: "active" | "inactive" | "unknown";
  readonly classification: DiagnosticClassificationKind;
  readonly evidenceRefs: readonly string[];
}

export interface DiagnosticContextPressure {
  readonly usedTokens: number;
  readonly maxTokens: number;
}

export interface DiagnosticsOverview {
  readonly service: {
    readonly status: "ok" | "degraded" | "stopping" | "failed";
    readonly version: string;
    readonly uptimeSeconds: number;
    readonly startedAt: string;
    readonly drainMode: "active" | "inactive";
  };
  readonly classification: DiagnosticClassification;
  readonly denCore: DiagnosticStatusSnapshot;
  readonly denChannels: DiagnosticStatusSnapshot;
  readonly mcp: DiagnosticStatusSnapshot;
  readonly runtimeDb: RuntimeHealthSnapshot;
  readonly counts: DiagnosticCounts;
  readonly sessions: readonly DiagnosticSessionProjection[];
  readonly recentEvents: readonly DiagnosticEventRecord[];
}
