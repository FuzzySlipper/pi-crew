/** Subscription cursor state helpers for Den HTTP direct-agent polling. */
import type { DirectAgentEventItem } from "./connection-http-client.js";
import type {
  ChannelSubscriptionCursorReadback,
  ChannelSubscriptionReadbackItem,
} from "./connection-http-subscription-client.js";
import type { DenHttpConnectionConfig } from "./connection-types.js";

export interface ActiveSubscriptionState {
  readonly subscriptionId: number;
  readonly membershipId: string | null;
  readonly channelId: string;
  readonly memberIdentity: string;
  readonly profileIdentity?: string | null;
  readonly agentInstanceId?: string | null;
  readonly subscriptionIdentity: string;
  readonly subscriptionStatus: string;
  readonly targetProjectId?: string | null;
  readonly targetTaskId?: number | null;
  readonly assignmentId?: string | null;
  readonly workerRunId?: string | null;
  readonly workerRole?: string | null;
}

export function selectActiveSubscription(
  config: DenHttpConnectionConfig,
  items: readonly ChannelSubscriptionReadbackItem[],
  membershipId: number | null,
): ActiveSubscriptionState | null {
  const configured = config.subscription;
  if (configured === undefined) return null;
  const selected = items.find((item) => item.subscriptionIdentity === configured.subscriptionIdentity)
    ?? items.find((item) => String(item.channelId) === configured.channelId)
    ?? null;
  if (selected === null) return null;
  return {
    subscriptionId: selected.subscriptionId,
    membershipId: membershipId === null ? null : String(membershipId),
    channelId: String(selected.channelId),
    memberIdentity: selected.memberIdentity,
    profileIdentity: selected.profileIdentity,
    agentInstanceId: selected.agentInstanceId,
    subscriptionIdentity: selected.subscriptionIdentity,
    subscriptionStatus: selected.subscriptionStatus,
    targetProjectId: selected.targetProjectId,
    targetTaskId: selected.targetTaskId,
    assignmentId: selected.assignmentId,
    workerRunId: selected.workerRunId,
    workerRole: selected.workerRole,
  };
}

export function readSubscriptionMessageCursor(
  cursors: readonly ChannelSubscriptionCursorReadback[],
): number | null {
  const cursor = cursors.find((item) => item.streamKind === "subscription_messages");
  if (cursor === undefined || !Number.isFinite(cursor.lastSeenId) || cursor.lastSeenId <= 0) return null;
  return cursor.lastSeenId;
}

export function cursorJsonForEvent(
  config: DenHttpConnectionConfig,
  state: ActiveSubscriptionState,
  item: DirectAgentEventItem,
): string {
  return JSON.stringify({
    source: "pi-crew-http-direct-agent-connection",
    memberIdentity: config.memberIdentity,
    channelId: state.channelId,
    subscriptionIdentity: state.subscriptionIdentity,
    eventId: item.id,
    sourceKind: item.sourceKind ?? null,
    observedAt: new Date().toISOString(),
  });
}

export function subscriptionMetadata(state: ActiveSubscriptionState): Record<string, unknown> {
  return {
    subscriptionId: String(state.subscriptionId),
    membershipId: state.membershipId,
    memberIdentity: state.memberIdentity,
    profileIdentity: state.profileIdentity,
    agentInstanceId: state.agentInstanceId,
    subscriptionIdentity: state.subscriptionIdentity,
    subscriptionStatus: state.subscriptionStatus,
    subscriptionChannelId: state.channelId,
    subscriptionTargetProjectId: state.targetProjectId,
    subscriptionTargetTaskId: state.targetTaskId,
    subscriptionAssignmentId: state.assignmentId,
    subscriptionWorkerRunId: state.workerRunId,
    subscriptionWorkerRole: state.workerRole,
  };
}
