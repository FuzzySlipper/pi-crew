import type { CrewConfig } from "./config.js";
import type { DenPoolCleanupGroup } from "./den-pool-cleanup.js";
import type { DenPoolMemberConfig } from "./den-pool-source.js";

export interface WorkerPoolGroupConfig {
  readonly groupId: string;
  readonly role: string;
  readonly profileIdentity: string;
  readonly profileId: string;
  readonly desiredSize: number;
  readonly identityTemplate: string;
  readonly displayNameTemplate?: string;
  readonly capabilities: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
}

export interface GroupOwnedPoolMemberCandidate {
  readonly workerIdentity: string;
  readonly metadata?: string | null;
}

export interface GroupOwnedPoolMemberSelectorConfig {
  readonly groupId: string;
  readonly owner: string;
}

export type GroupOwnedPoolMemberSelector = (candidate: GroupOwnedPoolMemberCandidate) => boolean;

export function resolveWorkerPoolMembers(config: CrewConfig): readonly DenPoolMemberConfig[] {
  if (config.workerPool.groups.length === 0) return config.workerPool.members;

  return config.workerPool.groups.flatMap((group) => expandWorkerPoolGroup(config, group));
}

export function resolveWorkerPoolCleanupGroups(config: CrewConfig): readonly DenPoolCleanupGroup[] {
  return config.workerPool.groups.map((group) => ({
    profileIdentity: group.profileIdentity,
    groupId: group.groupId,
    owner: ownerLabel(group),
    desiredWorkerIdentities: new Set(
      expandWorkerPoolGroup(config, group).map((member) => member.workerIdentity),
    ),
  }));
}

export function buildGroupOwnedPoolMemberSelector(
  config: GroupOwnedPoolMemberSelectorConfig,
): GroupOwnedPoolMemberSelector {
  return (candidate) => {
    const metadata = parseMetadata(candidate.metadata);
    if (metadata === undefined) return false;
    return metadata["pool_group"] === config.groupId && metadata["owner"] === config.owner;
  };
}

function expandWorkerPoolGroup(
  config: CrewConfig,
  group: WorkerPoolGroupConfig,
): readonly DenPoolMemberConfig[] {
  return Array.from({ length: group.desiredSize }, (_, zeroBasedIndex) => {
    const laneIndex = zeroBasedIndex + 1;
    const workerIdentity = group.identityTemplate.replace("{n}", String(laneIndex));
    return {
      workerIdentity,
      profileIdentity: group.profileIdentity,
      role: group.role,
      displayName: displayName(group, laneIndex),
      capabilities: [...group.capabilities],
      profileId: group.profileId,
      metadata: {
        install_root: config.install.root,
        profile_id: group.profileId,
        execution_mode: "llmAgent",
        pool_group: group.groupId,
        group_id: group.groupId,
        desired_size: group.desiredSize,
        lane_index: laneIndex,
        identity_template: group.identityTemplate,
        owner: ownerLabel(group),
        labels: group.labels ?? {},
      },
    };
  });
}

function displayName(group: WorkerPoolGroupConfig, laneIndex: number): string {
  if (group.displayNameTemplate !== undefined) {
    return group.displayNameTemplate.replace("{n}", String(laneIndex));
  }
  return `${group.groupId} lane ${String(laneIndex)}`;
}

function ownerLabel(group: WorkerPoolGroupConfig): string {
  return group.labels?.["owner"] ?? "pi-crew";
}

function parseMetadata(metadata: string | null | undefined): Record<string, unknown> | undefined {
  if (metadata === undefined || metadata === null || metadata.length === 0) return undefined;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
