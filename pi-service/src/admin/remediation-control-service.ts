/** Guarded local remediation controls for the admin HTTP surface. */
import type { EventBus } from "@pi-crew/core";
import type { DiagnosticsProjector } from "./admin-server.js";
import type { InstancePool } from "../instances/instance-pool.js";
import type { AuditEventInput, AuditRepository, DenAssignmentReader } from "../persistence/types.js";
import type { SessionStore } from "../sessions/session-store.js";

export type RemediationAction =
  | "drain"
  | "resume"
  | "recreate_instance"
  | "mark_local_stale"
  | "config_validate"
  | "config_reload";

export interface RemediationRequest {
  readonly operator: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly dryRun?: boolean;
  readonly candidateConfig?: unknown;
}

export interface RemediationResult {
  readonly controlId: string;
  readonly dryRun: boolean;
  readonly accepted: boolean;
  readonly action: RemediationAction;
  readonly operator: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown> | null;
  readonly denEvidence: DenEvidence;
  readonly localAuditId: number;
  readonly warnings: readonly string[];
}

export interface DenEvidence {
  readonly posted: boolean;
  readonly messageId: number | null;
  readonly notificationId: number | null;
  readonly status?: string;
}

export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface RemediationEvidenceInput {
  readonly action: RemediationAction;
  readonly accepted: boolean;
  readonly operator: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly dryRun: boolean;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown> | null;
  readonly warnings: readonly string[];
}

export interface RemediationEvidencePoster {
  postEvidence(input: RemediationEvidenceInput): Promise<DenEvidence>;
}

export interface RemediationDeps {
  readonly diagnostics: DiagnosticsProjector;
  readonly auditRepository: AuditRepository;
  readonly eventBus: EventBus;
  readonly sessionStore?: SessionStore;
  readonly instancePool?: InstancePool;
  readonly denAssignmentReader?: DenAssignmentReader;
  readonly evidencePoster?: RemediationEvidencePoster;
  readonly validateConfig?: (raw: unknown) => ConfigValidationResult;
  readonly clock?: () => string;
  readonly idFactory?: () => string;
}

interface ControlState {
  drainMode: "active" | "inactive";
  lastValidConfigKey: string | null;
}

interface IdempotencyRecord {
  readonly requestFingerprint: string;
  readonly result: RemediationResult;
}

export class RemediationControlService {
  readonly #diagnostics: DiagnosticsProjector;
  readonly #auditRepository: AuditRepository;
  readonly #eventBus: EventBus;
  readonly #sessionStore?: SessionStore;
  readonly #instancePool?: InstancePool;
  readonly #denAssignmentReader?: DenAssignmentReader;
  readonly #evidencePoster?: RemediationEvidencePoster;
  readonly #validateConfig?: (raw: unknown) => ConfigValidationResult;
  readonly #clock: () => string;
  readonly #idFactory: () => string;
  readonly #state: ControlState = { drainMode: "inactive", lastValidConfigKey: null };
  readonly #idempotency = new Map<string, IdempotencyRecord>();

  constructor(deps: RemediationDeps) {
    this.#diagnostics = deps.diagnostics;
    this.#auditRepository = deps.auditRepository;
    this.#eventBus = deps.eventBus;
    this.#sessionStore = deps.sessionStore;
    this.#instancePool = deps.instancePool;
    this.#denAssignmentReader = deps.denAssignmentReader;
    this.#evidencePoster = deps.evidencePoster;
    this.#validateConfig = deps.validateConfig;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
    this.#idFactory = deps.idFactory ?? (() => `ctrl_${crypto.randomUUID()}`);
  }

  async drain(request: RemediationRequest): Promise<RemediationResult> {
    return this.#run("drain", request, () => {
      const before = { drainMode: this.#state.drainMode };
      if (!request.dryRun) this.#state.drainMode = "active";
      return {
        accepted: true,
        before,
        after: { drainMode: request.dryRun ? this.#state.drainMode : "active" },
        warnings: [],
        denEvidence: localEvidence("local_drain_only"),
      };
    });
  }

  async resume(request: RemediationRequest): Promise<RemediationResult> {
    return this.#run("resume", request, async () => {
      const before = { drainMode: this.#state.drainMode };
      const overview = await this.#diagnostics.projectOverview();
      const connectivityOk = overview.denCore.status !== "unreachable";
      if (!connectivityOk) {
        return denied(before, "den_core_unreachable", ["Den Core must be reachable before resume"]);
      }
      if (!request.dryRun) this.#state.drainMode = "inactive";
      return {
        accepted: true,
        before,
        after: { drainMode: request.dryRun ? this.#state.drainMode : "inactive" },
        warnings: [],
        denEvidence: localEvidence("local_resume_only"),
      };
    });
  }

  async recreateInstance(sessionId: string, request: RemediationRequest): Promise<RemediationResult> {
    return this.#run("recreate_instance", request, async () => {
      const session = await this.#sessionStore?.get(sessionId);
      const before = { sessionId, kind: session?.kind ?? "missing", instanceId: session?.instanceId ?? null };
      if (session === undefined || session === null) return denied(before, "session_not_found", []);
      if (session.kind !== "conversational") return denied(before, "worker_sessions_den_sovereign", []);
      if (request.dryRun) {
        return { accepted: true, before, after: null, warnings: [], denEvidence: localEvidence("dry_run") };
      }
      if (session.instanceId !== null) await this.#instancePool?.release(session.instanceId);
      const nextInstance = await this.#instancePool?.acquire(session.profileId);
      const updated = await this.#sessionStore?.save({
        ...session,
        instanceId: nextInstance?.id ?? null,
        state: "active",
        lastActiveAt: this.#clock(),
      });
      return {
        accepted: true,
        before,
        after: { sessionId, instanceId: updated?.instanceId ?? null },
        warnings: nextInstance === undefined ? ["instance pool not wired; session record refreshed only"] : [],
        denEvidence: localEvidence("conversation_history_preserved"),
      };
    });
  }

  async markWorkerLocalStale(
    assignmentId: string,
    request: RemediationRequest,
  ): Promise<RemediationResult> {
    return this.#run("mark_local_stale", request, async () => {
      const overview = await this.#diagnostics.projectOverview();
      const session = overview.sessions.find(
        (item) => item.workerBinding?.assignmentId === assignmentId,
      );
      const before = {
        assignmentId,
        localSessionId: session?.sessionId ?? null,
        denAssignmentActive: session?.denAssignment?.isActive ?? null,
      };
      if (this.#denAssignmentReader === undefined || overview.denCore.status === "unreachable") {
        return denied(before, "den_state_unavailable", ["Den assignment readback is required"]);
      }
      if (session === undefined || !hasStaleEvidence(session.evidenceRefs)) {
        return denied(before, "local_stale_evidence_missing", []);
      }
      const denStatuses = await this.#denAssignmentReader.checkAssignments([assignmentId]);
      const denStatus = denStatuses.find((item) => item.assignmentId === assignmentId);
      if (denStatus === undefined || !denStatus.isActive) {
        return denied({ ...before, denStatus: denStatus?.terminalState ?? "missing" }, "den_disagrees", []);
      }
      return {
        accepted: true,
        before,
        after: request.dryRun ? null : { assignmentId, localStale: true },
        warnings: request.dryRun ? ["dry run; no stale marker persisted"] : [],
        denEvidence: localEvidence("den_release_request_required_outside_admin_api"),
      };
    });
  }

  async validateConfig(request: RemediationRequest): Promise<RemediationResult> {
    return this.#run("config_validate", request, () => {
      const before = { validationCache: this.#state.lastValidConfigKey };
      const validation = this.#validateConfig?.(request.candidateConfig) ?? {
        valid: false,
        errors: ["config validator unavailable"],
      };
      if (!validation.valid) return denied(before, "config_invalid", validation.errors);
      if (!request.dryRun) this.#state.lastValidConfigKey = request.idempotencyKey;
      return {
        accepted: true,
        before,
        after: { validationCache: request.idempotencyKey },
        warnings: [],
        denEvidence: localEvidence("config_validated_only"),
      };
    });
  }

  async reloadConfig(request: RemediationRequest): Promise<RemediationResult> {
    return this.#run("config_reload", request, () => {
      const before = { validationCache: this.#state.lastValidConfigKey };
      const validation = this.#validateConfig?.(request.candidateConfig) ?? {
        valid: false,
        errors: ["config validator unavailable"],
      };
      if (!validation.valid) return denied(before, "config_invalid", validation.errors);
      if (!request.dryRun) this.#state.lastValidConfigKey = request.idempotencyKey;
      return {
        accepted: true,
        before,
        after: request.dryRun ? null : { validationCache: request.idempotencyKey, applied: true },
        warnings: ["reload applies only validated hot-safe sections; restart may still be required"],
        denEvidence: localEvidence("config_reload_local_only"),
      };
    });
  }

  async #run(
    action: RemediationAction,
    request: RemediationRequest,
    handler: () => Promise<ControlOutcome> | ControlOutcome,
  ): Promise<RemediationResult> {
    const validationError = validateRequest(request);
    if (validationError !== null) return this.#invalid(action, request, validationError);
    const fingerprint = stableFingerprint(action, request);
    const cached = this.#idempotency.get(request.idempotencyKey);
    if (cached !== undefined) {
      if (cached.requestFingerprint === fingerprint) return cached.result;
      return this.#invalid(action, request, "idempotency key reused with different payload");
    }

    this.#eventBus.emit({ event: "admin.control.requested", payload: eventPayload(action, request) });
    const outcome = await handler();
    const denEvidence = await this.#postDenEvidence(action, request, outcome);
    const outcomeWithEvidence = { ...outcome, denEvidence };
    const auditId = await this.#audit(action, request, outcomeWithEvidence);
    const result = toResult(action, request, outcomeWithEvidence, auditId, this.#idFactory());
    this.#idempotency.set(request.idempotencyKey, { requestFingerprint: fingerprint, result });
    this.#eventBus.emit({
      event: "admin.control.completed",
      payload: { ...eventPayload(action, request), accepted: result.accepted, localAuditId: auditId },
    });
    return result;
  }

  async #invalid(
    action: RemediationAction,
    request: RemediationRequest,
    error: string,
  ): Promise<RemediationResult> {
    const outcome = denied({}, "invalid_request", [error]);
    const auditId = await this.#audit(action, request, outcome);
    return toResult(action, request, outcome, auditId, this.#idFactory());
  }

  async #postDenEvidence(
    action: RemediationAction,
    request: RemediationRequest,
    outcome: ControlOutcome,
  ): Promise<DenEvidence> {
    if (this.#evidencePoster === undefined) return outcome.denEvidence;
    const overview = await this.#diagnostics.projectOverview();
    if (overview.denCore.status === "unreachable") return outcome.denEvidence;
    const posted = await this.#evidencePoster.postEvidence({
      action,
      accepted: outcome.accepted,
      operator: request.operator,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      dryRun: request.dryRun === true,
      before: outcome.before,
      after: outcome.after,
      warnings: outcome.warnings,
    });
    return { ...posted, status: outcome.denEvidence.status ?? posted.status };
  }

  async #audit(
    action: RemediationAction,
    request: RemediationRequest,
    outcome: ControlOutcome,
  ): Promise<number> {
    const input: AuditEventInput = {
      eventType: `admin.control.${action}`,
      eventData: {
        at: this.#clock(),
        operator: request.operator,
        reason: request.reason,
        idempotencyKey: request.idempotencyKey,
        dryRun: request.dryRun === true,
        accepted: outcome.accepted,
        before: outcome.before,
        after: outcome.after,
        warnings: outcome.warnings,
        denEvidence: outcome.denEvidence,
      },
    };
    return this.#auditRepository.write(input);
  }
}

interface ControlOutcome {
  readonly accepted: boolean;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown> | null;
  readonly denEvidence: DenEvidence;
  readonly warnings: readonly string[];
}

function validateRequest(request: RemediationRequest): string | null {
  if (request.operator.trim().length === 0) return "operator is required";
  if (request.reason.trim().length === 0) return "reason is required";
  if (request.idempotencyKey.trim().length === 0) return "idempotencyKey is required";
  return null;
}

function denied(
  before: Record<string, unknown>,
  status: string,
  warnings: readonly string[],
): ControlOutcome {
  return { accepted: false, before, after: null, warnings, denEvidence: localEvidence(status) };
}

function toResult(
  action: RemediationAction,
  request: RemediationRequest,
  outcome: ControlOutcome,
  auditId: number,
  controlId: string,
): RemediationResult {
  return {
    controlId,
    dryRun: request.dryRun === true,
    accepted: outcome.accepted,
    action,
    operator: request.operator,
    reason: request.reason,
    idempotencyKey: request.idempotencyKey,
    before: outcome.before,
    after: outcome.after,
    denEvidence: outcome.denEvidence,
    localAuditId: auditId,
    warnings: outcome.warnings,
  };
}

function eventPayload(action: RemediationAction, request: RemediationRequest) {
  return {
    action,
    operator: request.operator,
    reason: request.reason,
    idempotencyKey: request.idempotencyKey,
    dryRun: request.dryRun === true,
  };
}

function stableFingerprint(action: RemediationAction, request: RemediationRequest): string {
  return JSON.stringify({ action, request });
}

function localEvidence(status: string): DenEvidence {
  return { posted: false, messageId: null, notificationId: null, status };
}

function hasStaleEvidence(evidenceRefs: readonly string[]): boolean {
  return evidenceRefs.some((ref) => ref.includes("worker.stuck") || ref.includes("assignment.timed_out"));
}
