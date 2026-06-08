/** HTTP client helpers for Den Channels v8 membership/subscription routes. */
import {
  ConnectionError,
  type ChannelMembership,
  type ChannelMembershipUpsert,
  type ChannelPresence,
  type ChannelPresenceQuery,
  type ChannelSubscription,
  type ChannelSubscriptionRelease,
  type ChannelSubscriptionStatusUpdate,
  type ChannelSubscriptionUpsert,
  type Logger,
} from "@pi-crew/core";

import type { DenHttpConnectionConfig, DenHttpSubscriptionConfig } from "./connection-types.js";

interface MembershipWireResponse {
  readonly id?: number;
  readonly membershipId?: number;
}

interface SubscriptionRegistrationResult {
  readonly membershipId: number | null;
}

export interface ChannelSubscriptionReadback {
  readonly memberIdentity: string;
  readonly subscriptions: readonly unknown[];
}

export interface HttpSubscriptionClientOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export class HttpSubscriptionClient {
  readonly #config: DenHttpConnectionConfig;
  readonly #logger: Logger;
  readonly #fetchFn: typeof fetch;
  readonly #timeoutMs: number;

  constructor(config: DenHttpConnectionConfig, logger: Logger, options?: HttpSubscriptionClientOptions) {
    this.#config = config;
    this.#logger = logger;
    this.#fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async register(signal: AbortSignal): Promise<SubscriptionRegistrationResult> {
    const subscription = requireSubscription(this.#config);
    const membershipId = await this.#upsertMembership(subscription, signal);
    await this.#upsertSubscription(subscription, membershipId, "active", signal);
    return { membershipId };
  }

  async release(signal: AbortSignal): Promise<void> {
    const subscription = this.#config.subscription;
    if (subscription === undefined) return;
    await this.#upsertSubscription(
      subscription,
      null,
      subscription.closeStatus ?? "degraded",
      signal,
    );
  }

  async readSubscriptions(signal: AbortSignal): Promise<ChannelSubscriptionReadback> {
    const subscription = requireSubscription(this.#config);
    const url = new URL(`${this.#baseUrl()}/api/channel-subscriptions`);
    url.searchParams.set("memberIdentity", this.#config.memberIdentity);
    url.searchParams.set("purpose", "ordinary_channel");
    url.searchParams.set("projectId", this.#config.projectId);
    url.searchParams.set("channelId", subscription.channelId);
    const response = await this.#fetchWithTimeout(url.toString(), {
      method: "GET",
      headers: this.#jsonHeaders(),
      signal,
    });
    if (!response.ok) {
      throw new ConnectionError(`Subscription readback failed with HTTP ${String(response.status)}`);
    }
    return (await response.json()) as ChannelSubscriptionReadback;
  }

  async upsertMembership(input: ChannelMembershipUpsert, signal: AbortSignal): Promise<ChannelMembership> {
    const response = await this.#fetchWithTimeout(
      `${this.#baseUrl()}/api/channels/${encodeURIComponent(input.channelId)}/memberships`,
      {
        method: "PUT",
        headers: this.#jsonHeaders(),
        body: JSON.stringify({
          memberType: input.memberType,
          memberIdentity: input.memberIdentity,
          membershipStatus: input.status ?? "active",
          wakePolicy: input.wakePolicy ?? "subscription",
          canSend: true,
          canReact: true,
          canInvite: false,
          profileIdentity: input.profileIdentity,
          memberRole: input.memberRole,
        }),
        signal,
      },
    );
    if (!response.ok) throw new ConnectionError(`Membership upsert failed with HTTP ${String(response.status)}`);
    const payload: unknown = await response.json();
    return {
      ...input,
      membershipId: String(readMembershipId(payload) ?? `${input.channelId}:${input.memberIdentity}`),
      status: input.status ?? "active",
      updatedAt: new Date(),
    };
  }

  async upsertSubscription(input: ChannelSubscriptionUpsert, signal: AbortSignal): Promise<ChannelSubscription> {
    const response = await this.#fetchWithTimeout(
      `${this.#baseUrl()}/api/channels/${encodeURIComponent(input.channelId)}/subscriptions`,
      {
        method: "PUT",
        headers: this.#jsonHeaders(),
        body: JSON.stringify({
          memberType: "agent",
          memberIdentity: input.memberIdentity,
          profileIdentity: input.profileIdentity,
          agentInstanceId: input.agentInstanceId,
          subscriptionIdentity: input.subscriptionIdentity,
          subscriptionPurpose: input.purpose,
          subscriptionStatus: input.status ?? "active",
          sourceProjectId: this.#config.projectId,
          sessionOwnerId: input.sessionOwnerId,
          sessionId: input.sessionId,
          wakePolicyOverride: "subscription",
        }),
        signal,
      },
    );
    if (!response.ok) throw new ConnectionError(`Subscription upsert failed with HTTP ${String(response.status)}`);
    return {
      ...input,
      subscriptionId: `${input.channelId}:${input.subscriptionIdentity}`,
      status: input.status ?? "active",
      updatedAt: new Date(),
    };
  }

  async releaseSubscription(input: ChannelSubscriptionRelease, signal: AbortSignal): Promise<void> {
    const subscription = requireSubscription(this.#config);
    await this.upsertSubscription({
      channelId: input.channelId,
      memberIdentity: this.#config.memberIdentity,
      subscriptionIdentity: input.subscriptionIdentity,
      purpose: "ordinary_channel",
      status: input.status ?? "offline",
      profileIdentity: subscription.profileIdentity,
      agentInstanceId: subscription.agentInstanceId,
      sessionOwnerId: subscription.sessionOwnerId,
      sessionId: subscription.sessionId,
    }, signal);
  }

  async updateSubscriptionStatus(input: ChannelSubscriptionStatusUpdate, signal: AbortSignal): Promise<void> {
    await this.releaseSubscription({
      channelId: input.channelId,
      subscriptionIdentity: input.subscriptionIdentity,
      status: input.status === "active" || input.status === "busy" ? "needs_rebind" : input.status,
      evidenceRefs: input.evidenceRefs,
    }, signal);
  }

  getPresence(_input: ChannelPresenceQuery, _signal: AbortSignal): Promise<readonly ChannelPresence[]> {
    void _input;
    void _signal;
    return Promise.resolve([]);
  }

  async #upsertMembership(
    subscription: DenHttpSubscriptionConfig,
    signal: AbortSignal,
  ): Promise<number | null> {
    const response = await this.#fetchWithTimeout(
      `${this.#baseUrl()}/api/channels/${encodeURIComponent(subscription.channelId)}/memberships`,
      {
        method: "PUT",
        headers: this.#jsonHeaders(),
        body: JSON.stringify({
          memberType: "agent",
          memberIdentity: this.#config.memberIdentity,
          membershipStatus: "active",
          wakePolicy: "subscription",
          canSend: true,
          canReact: true,
          canInvite: false,
          profileIdentity: subscription.profileIdentity,
          memberRole: subscription.memberRole,
        }),
        signal,
      },
    );
    if (!response.ok) {
      this.#logger.warn("Membership upsert returned non-OK", { status: response.status });
      throw new ConnectionError(`Membership upsert failed with HTTP ${String(response.status)}`);
    }
    const payload: unknown = await response.json();
    return readMembershipId(payload);
  }

  async #upsertSubscription(
    subscription: DenHttpSubscriptionConfig,
    membershipId: number | null,
    status: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.#fetchWithTimeout(
      `${this.#baseUrl()}/api/channels/${encodeURIComponent(subscription.channelId)}/subscriptions`,
      {
        method: "PUT",
        headers: this.#jsonHeaders(),
        body: JSON.stringify({
          memberType: "agent",
          memberIdentity: this.#config.memberIdentity,
          profileIdentity: subscription.profileIdentity,
          agentInstanceId: subscription.agentInstanceId,
          subscriptionIdentity: subscription.subscriptionIdentity,
          subscriptionPurpose: "ordinary_channel",
          subscriptionStatus: status,
          membershipId,
          sourceProjectId: this.#config.projectId,
          sessionOwnerId: subscription.sessionOwnerId,
          sessionId: subscription.sessionId,
          wakePolicyOverride: "subscription",
        }),
        signal,
      },
    );
    if (!response.ok) {
      this.#logger.warn("Subscription upsert returned non-OK", { status: response.status });
      throw new ConnectionError(`Subscription upsert failed with HTTP ${String(response.status)}`);
    }
  }

  #baseUrl(): string {
    return this.#config.baseUrl.replace(/\/+$/, "");
  }

  #jsonHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.#config.token.length > 0) headers.Authorization = `Bearer ${this.#config.token}`;
    return headers;
  }

  async #fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    const combinedSignal = init.signal ? anySignal([init.signal, controller.signal]) : controller.signal;
    try {
      return await this.#fetchFn(url, { ...init, signal: combinedSignal });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function requireSubscription(config: DenHttpConnectionConfig): DenHttpSubscriptionConfig {
  const subscription = config.subscription;
  if (subscription === undefined) {
    throw new ConnectionError("Den HTTP subscription registration is required unless legacy polling fallback is explicit");
  }
  const required: Array<keyof DenHttpSubscriptionConfig> = [
    "channelId",
    "profileIdentity",
    "agentInstanceId",
    "sessionOwnerId",
    "sessionId",
    "subscriptionIdentity",
  ];
  for (const key of required) {
    const value = subscription[key];
    if (value === undefined || value.length === 0) {
      throw new ConnectionError(`Den HTTP subscription config missing ${key}`);
    }
  }
  return subscription;
}

function readMembershipId(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as MembershipWireResponse;
  return record.membershipId ?? record.id ?? null;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1 && signals[0] !== undefined) return signals[0];
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}
