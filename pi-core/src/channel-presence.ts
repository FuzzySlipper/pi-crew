export type ChannelMemberType = "human" | "agent" | "system";
export type ChannelMembershipStatus = "active" | "muted" | "left" | "banned";

export type ChannelSubscriptionPurpose =
  | "ordinary_channel"
  | "worker_pool_control"
  | "target_work"
  | "coordination_call";

export type ChannelSubscriptionStatus =
  | "active"
  | "idle"
  | "busy"
  | "degraded"
  | "offline"
  | "needs_rebind";

export type ChannelPresenceState =
  | "active"
  | "idle"
  | "busy"
  | "degraded"
  | "offline"
  | "left"
  | "needs_rebind"
  | "stale"
  | "unknown";

export type ChannelWakePolicy = "none" | "mention" | "direct" | "subscription";

export interface ChannelWorkRefs {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly assignmentId?: string;
  readonly runId?: string;
  readonly coordinationCallId?: string;
}

export interface ChannelEvidenceRefs {
  readonly membershipId?: string;
  readonly subscriptionId?: string;
  readonly lifecycleEventId?: string;
  readonly directAgentEventId?: string;
  readonly checkpointId?: string;
}

export interface ChannelMembershipUpsert {
  readonly channelId: string;
  readonly memberIdentity: string;
  readonly memberType: ChannelMemberType;
  readonly profileIdentity?: string;
  readonly memberRole?: string;
  readonly displayName?: string;
  readonly status?: ChannelMembershipStatus;
  readonly wakePolicy?: ChannelWakePolicy;
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelMembership extends ChannelMembershipUpsert {
  readonly membershipId: string;
  readonly status: ChannelMembershipStatus;
  readonly updatedAt: Date;
}

export interface ChannelSubscriptionUpsert {
  readonly channelId: string;
  readonly memberIdentity: string;
  readonly subscriptionIdentity: string;
  readonly purpose: ChannelSubscriptionPurpose;
  readonly status?: ChannelSubscriptionStatus;
  readonly profileIdentity?: string;
  readonly agentInstanceId?: string;
  readonly sessionOwnerId?: string;
  readonly sessionId?: string;
  readonly workRefs?: ChannelWorkRefs;
  readonly evidenceRefs?: ChannelEvidenceRefs;
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelSubscription extends ChannelSubscriptionUpsert {
  readonly subscriptionId: string;
  readonly status: ChannelSubscriptionStatus;
  readonly lastSeenAt?: Date;
  readonly lastClaimedAt?: Date;
  readonly updatedAt: Date;
}

export interface ChannelSubscriptionRelease {
  readonly channelId: string;
  readonly subscriptionIdentity: string;
  readonly status?: Extract<ChannelSubscriptionStatus, "idle" | "degraded" | "offline" | "needs_rebind">;
  readonly evidenceRefs?: ChannelEvidenceRefs;
}

export interface ChannelSubscriptionStatusUpdate {
  readonly channelId: string;
  readonly subscriptionIdentity: string;
  readonly status: ChannelSubscriptionStatus;
  readonly lastSeenAt?: Date;
  readonly lastClaimedAt?: Date;
  readonly evidenceRefs?: ChannelEvidenceRefs;
}

export interface ChannelPresenceQuery {
  readonly channelId: string;
  readonly memberIdentity?: string;
  readonly subscriptionIdentity?: string;
  readonly purpose?: ChannelSubscriptionPurpose;
}

export interface ChannelPresence {
  readonly channelId: string;
  readonly memberIdentity: string;
  readonly memberType: ChannelMemberType;
  readonly profileIdentity?: string;
  readonly memberRole?: string;
  readonly membershipStatus: ChannelMembershipStatus;
  readonly presenceState: ChannelPresenceState;
  readonly reachability: "reachable" | "unreachable" | "unknown";
  readonly subscription?: ChannelSubscription;
  readonly evidenceRefs?: ChannelEvidenceRefs;
  readonly lastSeenAt?: Date;
  readonly lastClaimedAt?: Date;
  readonly lastActivityAt?: Date;
}

export interface ChannelMembershipProvider {
  upsertMembership(input: ChannelMembershipUpsert): Promise<ChannelMembership>;
  upsertSubscription(input: ChannelSubscriptionUpsert): Promise<ChannelSubscription>;
  releaseSubscription(input: ChannelSubscriptionRelease): Promise<void>;
}

export interface ChannelPresenceProvider {
  getPresence(input: ChannelPresenceQuery): Promise<readonly ChannelPresence[]>;
  updateSubscriptionStatus(input: ChannelSubscriptionStatusUpdate): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isChannelMembershipProvider(value: unknown): value is ChannelMembershipProvider {
  return isRecord(value)
    && typeof value.upsertMembership === "function"
    && typeof value.upsertSubscription === "function"
    && typeof value.releaseSubscription === "function";
}

export function isChannelPresenceProvider(value: unknown): value is ChannelPresenceProvider {
  return isRecord(value)
    && typeof value.getPresence === "function"
    && typeof value.updateSubscriptionStatus === "function";
}
