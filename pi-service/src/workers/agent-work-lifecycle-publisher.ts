/** Publish pi-crew agent-work breadcrumbs to Den Channels lifecycle events. */
import type { AgentWorkBreadcrumb, AgentWorkBreadcrumbRepository, BreadcrumbCorrelationFilter, BreadcrumbUpdateFields, Logger } from "@pi-crew/core";

/** Lifecycle publisher for non-waking Den Channels observability rows. */
export interface AgentWorkLifecyclePublisher {
  publish(breadcrumb: AgentWorkBreadcrumb): Promise<void>;
}

export interface PublishingAgentWorkBreadcrumbRepositoryConfig {
  readonly inner: AgentWorkBreadcrumbRepository;
  readonly publisher: AgentWorkLifecyclePublisher;
  readonly logger?: Logger;
}

/** Decorates local breadcrumb persistence with fail-open canonical lifecycle publishing. */
export class PublishingAgentWorkBreadcrumbRepository implements AgentWorkBreadcrumbRepository {
  readonly #inner: AgentWorkBreadcrumbRepository;
  readonly #publisher: AgentWorkLifecyclePublisher;
  readonly #logger: Logger | null;

  constructor(config: PublishingAgentWorkBreadcrumbRepositoryConfig) {
    this.#inner = config.inner;
    this.#publisher = config.publisher;
    this.#logger = config.logger ?? null;
  }

  async append(breadcrumb: AgentWorkBreadcrumb): Promise<AgentWorkBreadcrumb> {
    const saved = await this.#inner.append(breadcrumb);
    this.publish(saved);
    return saved;
  }

  getById(id: string): Promise<AgentWorkBreadcrumb | null> {
    return this.#inner.getById(id);
  }

  async updateById(id: string, updates: BreadcrumbUpdateFields): Promise<AgentWorkBreadcrumb | null> {
    const updated = await this.#inner.updateById(id, updates);
    if (updated !== null) this.publish(updated);
    return updated;
  }

  async updateByCorrelation(
    filter: BreadcrumbCorrelationFilter,
    updates: BreadcrumbUpdateFields,
  ): Promise<AgentWorkBreadcrumb | null> {
    const updated = await this.#inner.updateByCorrelation(filter, updates);
    if (updated !== null) this.publish(updated);
    return updated;
  }

  queryByCorrelation(filter: BreadcrumbCorrelationFilter): Promise<AgentWorkBreadcrumb[]> {
    return this.#inner.queryByCorrelation(filter);
  }

  deleteById(id: string): Promise<void> {
    return this.#inner.deleteById(id);
  }

  private publish(breadcrumb: AgentWorkBreadcrumb): void {
    void this.#publisher.publish(breadcrumb).catch((error: unknown) => {
      this.#logger?.warn("agent_work.lifecycle_publish_failed", {
        breadcrumbId: breadcrumb.id,
        eventType: breadcrumb.eventType,
        error: errorMessage(error),
      });
    });
  }
}

export interface HttpAgentWorkLifecyclePublisherConfig {
  readonly baseUrl: string;
  readonly token?: string | null;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

interface LifecyclePayload {
  readonly channelId: number;
  readonly agentIdentity: string;
  readonly eventType: string;
  readonly projectId: string;
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly workerRunId?: string;
  readonly workerRole?: string;
  readonly profileIdentity?: string;
  readonly displayBlockId: string;
  readonly parentAgentIdentity?: string;
  readonly lastActivityAt: string;
  readonly stalenessDeadline?: string;
  readonly stateReason: string;
  readonly title: string;
  readonly summary: string;
  readonly metadataJson: string;
  readonly dedupeKey: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const STALENESS_MS = 60_000;

/** HTTP publisher for Den Channels /api/agent-work/lifecycle-events. */
export class HttpAgentWorkLifecyclePublisher implements AgentWorkLifecyclePublisher {
  readonly #baseUrl: string;
  readonly #token: string | null;
  readonly #fetchFn: typeof fetch;
  readonly #timeoutMs: number;
  readonly #logger: Logger | null;

  constructor(config: HttpAgentWorkLifecyclePublisherConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#token = config.token ?? null;
    this.#fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = config.logger ?? null;
  }

  async publish(breadcrumb: AgentWorkBreadcrumb): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetchFn(`${this.#baseUrl}/api/agent-work/lifecycle-events`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(toLifecyclePayload(breadcrumb)),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.#logger?.warn("agent_work.lifecycle_post_non_ok", {
          breadcrumbId: breadcrumb.id,
          status: response.status,
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.#token !== null && this.#token.trim() !== "") headers.Authorization = `Bearer ${this.#token}`;
    return headers;
  }
}

export function toLifecyclePayload(breadcrumb: AgentWorkBreadcrumb): LifecyclePayload {
  const metadata = metadataFor(breadcrumb);
  const payload: LifecyclePayload = {
    channelId: Number.parseInt(breadcrumb.channelId, 10),
    agentIdentity: agentIdentityFor(breadcrumb),
    eventType: canonicalEventTypeFor(breadcrumb),
    projectId: breadcrumb.projectId,
    sessionId: sessionIdFor(breadcrumb),
    parentSessionId: parentSessionIdFor(breadcrumb),
    workerRunId: workerRunIdFor(breadcrumb),
    workerRole: breadcrumb.eventFamily === "delegation" || isChildTool(breadcrumb) ? "subagent" : undefined,
    profileIdentity: profileIdFor(breadcrumb),
    displayBlockId: displayBlockIdFor(breadcrumb),
    parentAgentIdentity: parentAgentIdentityFor(breadcrumb),
    lastActivityAt: breadcrumb.createdAt,
    stalenessDeadline: terminalState(breadcrumb) ? undefined : new Date(Date.parse(breadcrumb.createdAt) + STALENESS_MS).toISOString(),
    stateReason: breadcrumb.summary,
    title: breadcrumb.eventType.replace(/^pi_crew\./, "").replace(/_/g, " "),
    summary: breadcrumb.summary,
    metadataJson: JSON.stringify(metadata),
    dedupeKey: `pi-crew:breadcrumb:${breadcrumb.id}:${breadcrumb.state}:${phaseFor(breadcrumb) ?? "none"}`,
  };
  return payload;
}

function metadataFor(breadcrumb: AgentWorkBreadcrumb): Record<string, unknown> {
  return {
    ...breadcrumb.metadata,
    ...breadcrumb.evidence,
    source: breadcrumb.source,
    eventFamily: breadcrumb.eventFamily,
    piCrewEventType: breadcrumb.eventType,
    state: breadcrumb.state,
    severity: breadcrumb.severity,
    profileId: profileIdFor(breadcrumb),
    provider: providerFor(breadcrumb),
    model: modelFor(breadcrumb),
    childSessionId: childSessionIdFor(breadcrumb),
    parentSessionId: parentSessionIdFor(breadcrumb),
    rootSessionId: rootSessionIdFor(breadcrumb),
    ownerSessionId: ownerSessionIdFor(breadcrumb),
    toolName: toolNameFor(breadcrumb),
    toolCallId: toolCallIdFor(breadcrumb),
    phase: phaseFor(breadcrumb),
    durationMs: durationMsFor(breadcrumb),
    isError: isErrorFor(breadcrumb),
    resultClass: resultClassFor(breadcrumb),
    outcome: outcomeFor(breadcrumb),
    turnsUsed: turnsUsedFor(breadcrumb),
    tokensConsumed: tokensConsumedFor(breadcrumb),
    evidenceChecked: evidenceCheckedFor(breadcrumb),
    artifactCount: artifactCountFor(breadcrumb),
    policyId: policyIdFor(breadcrumb),
    depth: depthFor(breadcrumb),
  };
}

function canonicalEventTypeFor(breadcrumb: AgentWorkBreadcrumb): string {
  if (breadcrumb.eventType === "pi_crew.parent.runtime_received") return "runtime_received";
  if (breadcrumb.eventType === "pi_crew.parent.request_claimed") return "request_claimed";
  if (breadcrumb.eventType.endsWith("turn_started")) return "agent_turn_started";
  if (breadcrumb.state === "completed" && breadcrumb.eventFamily !== "tool") return "completed";
  if (breadcrumb.state === "failed") return "failed";
  if (breadcrumb.state === "timeout") return "timed_out";
  if (breadcrumb.state === "denied" || breadcrumb.eventFamily === "tool") return "checkpoint_seen";
  return "checkpoint_seen";
}

function terminalState(breadcrumb: AgentWorkBreadcrumb): boolean {
  return breadcrumb.state === "completed" || breadcrumb.state === "failed" || breadcrumb.state === "timeout";
}

function displayBlockIdFor(breadcrumb: AgentWorkBreadcrumb): string {
  if (breadcrumb.eventFamily === "parent") return `pi-crew-agent:${breadcrumb.agentIdentity}:${breadcrumb.sessionId}`;
  const childSessionId = childSessionIdFor(breadcrumb);
  if (childSessionId !== undefined) return `pi-crew-delegation:${childSessionId}`;
  return `pi-crew-tool:${ownerSessionIdFor(breadcrumb) ?? "unknown"}:${toolCallIdFor(breadcrumb) ?? breadcrumb.id}`;
}

function agentIdentityFor(breadcrumb: AgentWorkBreadcrumb): string {
  if (breadcrumb.eventFamily === "parent") return breadcrumb.agentIdentity;
  if (breadcrumb.eventFamily === "delegation") return breadcrumb.profileId;
  return profileIdFor(breadcrumb) ?? parentAgentIdentityFor(breadcrumb) ?? "pi-crew";
}

function sessionIdFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  if (breadcrumb.eventFamily === "parent") return breadcrumb.sessionId;
  if (breadcrumb.eventFamily === "delegation") return breadcrumb.childSessionId;
  return breadcrumb.ownerSessionId;
}

function parentSessionIdFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  if (breadcrumb.eventFamily === "delegation") return breadcrumb.parentSessionId;
  if (breadcrumb.eventFamily === "tool") return stringFrom(breadcrumb.metadata.parentSessionId);
  return undefined;
}

function parentAgentIdentityFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  if (breadcrumb.eventFamily === "delegation") return breadcrumb.parentAgentIdentity;
  if (breadcrumb.eventFamily === "tool") return stringFrom(breadcrumb.metadata.agentIdentity) ?? stringFrom(breadcrumb.metadata.parentAgentIdentity);
  return undefined;
}

function profileIdFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  if (breadcrumb.eventFamily === "parent" || breadcrumb.eventFamily === "delegation") return breadcrumb.profileId;
  return stringFrom(breadcrumb.metadata.profileId);
}

function providerFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return "provider" in breadcrumb ? breadcrumb.provider : undefined;
}

function modelFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return "model" in breadcrumb ? breadcrumb.model : undefined;
}

function childSessionIdFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  if (breadcrumb.eventFamily === "delegation") return breadcrumb.childSessionId;
  if (breadcrumb.eventFamily === "tool") return stringFrom(breadcrumb.metadata.childSessionId) ?? breadcrumb.ownerSessionId;
  return undefined;
}

function rootSessionIdFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  if (breadcrumb.eventFamily === "delegation") return breadcrumb.rootSessionId;
  if (breadcrumb.eventFamily === "tool") return stringFrom(breadcrumb.metadata.rootSessionId);
  return undefined;
}

function ownerSessionIdFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return breadcrumb.eventFamily === "tool" ? breadcrumb.ownerSessionId : undefined;
}

function workerRunIdFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return childSessionIdFor(breadcrumb);
}

function isChildTool(breadcrumb: AgentWorkBreadcrumb): boolean {
  return breadcrumb.eventFamily === "tool" && childSessionIdFor(breadcrumb) !== undefined;
}

function toolNameFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return breadcrumb.eventFamily === "tool" ? breadcrumb.toolName : undefined;
}

function toolCallIdFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return breadcrumb.eventFamily === "tool" ? breadcrumb.toolCallId : undefined;
}

function phaseFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return breadcrumb.eventFamily === "tool" ? breadcrumb.phase : stringFrom(breadcrumb.metadata.phase);
}

function durationMsFor(breadcrumb: AgentWorkBreadcrumb): number | undefined {
  return "durationMs" in breadcrumb ? breadcrumb.durationMs : undefined;
}

function isErrorFor(breadcrumb: AgentWorkBreadcrumb): boolean | undefined {
  return breadcrumb.eventFamily === "tool" ? breadcrumb.isError : undefined;
}

function resultClassFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return breadcrumb.eventFamily === "tool" ? breadcrumb.resultClass : undefined;
}

function outcomeFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return "outcome" in breadcrumb ? breadcrumb.outcome : undefined;
}

function turnsUsedFor(breadcrumb: AgentWorkBreadcrumb): number | undefined {
  return "turnsUsed" in breadcrumb ? breadcrumb.turnsUsed : undefined;
}

function tokensConsumedFor(breadcrumb: AgentWorkBreadcrumb): number | undefined {
  return "tokensConsumed" in breadcrumb ? breadcrumb.tokensConsumed : undefined;
}

function evidenceCheckedFor(breadcrumb: AgentWorkBreadcrumb): boolean | undefined {
  return "evidenceChecked" in breadcrumb ? breadcrumb.evidenceChecked : undefined;
}

function artifactCountFor(breadcrumb: AgentWorkBreadcrumb): number | undefined {
  return "artifactCount" in breadcrumb ? breadcrumb.artifactCount : undefined;
}

function policyIdFor(breadcrumb: AgentWorkBreadcrumb): string | undefined {
  return "policyId" in breadcrumb ? breadcrumb.policyId : stringFrom(breadcrumb.metadata.policyId);
}

function depthFor(breadcrumb: AgentWorkBreadcrumb): number | undefined {
  return "depth" in breadcrumb ? breadcrumb.depth : undefined;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
