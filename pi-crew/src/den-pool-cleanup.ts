import type { MCPClient, ToolCallContentBlock } from "@pi-crew/mcp";

import type { DenPoolMemberConfig } from "./den-pool-source.js";

export interface DenPoolCleanupGroup {
  readonly profileIdentity: string;
  readonly groupId: string;
  readonly owner: string;
  readonly desiredWorkerIdentities: ReadonlySet<string>;
}

interface RawPoolMemberEnvelope {
  readonly worker_identity?: unknown;
  readonly profile_identity?: unknown;
  readonly worker_role?: unknown;
  readonly display_name?: unknown;
  readonly capabilities?: unknown;
  readonly status?: unknown;
  readonly metadata?: unknown;
}

interface ParsedToolPayload {
  readonly result?: unknown;
}

export class DenPoolCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DenPoolCleanupError";
  }
}

export async function reconcileStaleGroupMembers(config: {
  readonly mcpClient: MCPClient;
  readonly members: readonly DenPoolMemberConfig[];
  readonly cleanupGroups: readonly DenPoolCleanupGroup[];
}): Promise<string[]> {
  const groups = mergedCleanupGroups(config.members, config.cleanupGroups);
  const quarantined: string[] = [];

  for (const group of groups) {
    const result = await config.mcpClient.callTool("list_pool_members", {
      profile_identity: group.profileIdentity,
      limit: 200,
      verbose: true,
    });
    if (!result.ok) {
      throw new DenPoolCleanupError(
        `Den pool member cleanup read failed for ${group.groupId}: ${result.error ?? "unknown Den MCP error"}`,
      );
    }

    for (const member of readPoolMembers(result.content)) {
      const stale = staleGroupMember(group, member);
      if (stale === undefined) continue;
      const quarantine = await config.mcpClient.callTool("upsert_pool_member", {
        worker_identity: stale.workerIdentity,
        profile_identity: stale.profileIdentity,
        worker_role: stale.workerRole,
        display_name: stale.displayName,
        capabilities: stale.capabilities,
        status: "quarantined",
        metadata: stale.metadata,
      });
      if (!quarantine.ok) {
        throw new DenPoolCleanupError(
          `Den pool member quarantine failed for ${stale.workerIdentity}: ${quarantine.error ?? "unknown Den MCP error"}`,
        );
      }
      quarantined.push(stale.workerIdentity);
    }
  }

  return quarantined;
}

function mergedCleanupGroups(
  members: readonly DenPoolMemberConfig[],
  explicitGroups: readonly DenPoolCleanupGroup[],
): readonly DenPoolCleanupGroup[] {
  const groups = new Map<string, DenPoolCleanupGroup>();
  for (const group of explicitGroups) {
    groups.set(groupKey(group), group);
  }
  for (const group of desiredGroupProjections(members)) {
    groups.set(groupKey(group), group);
  }
  return [...groups.values()];
}

function desiredGroupProjections(members: readonly DenPoolMemberConfig[]): readonly DenPoolCleanupGroup[] {
  const groups = new Map<string, DenPoolCleanupGroup>();
  for (const member of members) {
    const metadata = member.metadata;
    const groupId = readMetadataString(metadata, "pool_group") ?? readMetadataString(metadata, "group_id");
    const owner = readMetadataString(metadata, "owner");
    if (groupId === undefined || owner === undefined) continue;
    const key = `${member.profileIdentity}\u0000${groupId}\u0000${owner}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        profileIdentity: member.profileIdentity,
        groupId,
        owner,
        desiredWorkerIdentities: new Set([member.workerIdentity]),
      });
      continue;
    }
    (existing.desiredWorkerIdentities as Set<string>).add(member.workerIdentity);
  }
  return [...groups.values()];
}

function groupKey(group: DenPoolCleanupGroup): string {
  return `${group.profileIdentity}\u0000${group.groupId}\u0000${group.owner}`;
}

function readPoolMembers(content: ReadonlyArray<ToolCallContentBlock>): readonly RawPoolMemberEnvelope[] {
  const payload = parseToolPayload(content);
  const data = unwrapJsonString(payload.result ?? payload);
  if (!isRecord(data)) return [];
  const members = data["members"];
  if (!Array.isArray(members)) return [];
  return members.filter(isRecord).map((member) => ({
    worker_identity: member["worker_identity"],
    profile_identity: member["profile_identity"],
    worker_role: member["worker_role"],
    display_name: member["display_name"],
    capabilities: member["capabilities"],
    status: member["status"],
    metadata: member["metadata"],
  }));
}

function staleGroupMember(
  group: DenPoolCleanupGroup,
  member: RawPoolMemberEnvelope,
):
  | {
      readonly workerIdentity: string;
      readonly profileIdentity: string;
      readonly workerRole: string;
      readonly displayName: string;
      readonly capabilities: string;
      readonly metadata: string;
    }
  | undefined {
  const workerIdentity = optionalString(member.worker_identity);
  const profileIdentity = optionalString(member.profile_identity);
  const workerRole = optionalString(member.worker_role);
  const metadata = optionalString(member.metadata);
  const status = optionalString(member.status);
  if (
    workerIdentity === undefined ||
    profileIdentity === undefined ||
    workerRole === undefined ||
    metadata === undefined ||
    status !== "available"
  ) {
    return undefined;
  }
  if (profileIdentity !== group.profileIdentity) return undefined;
  if (group.desiredWorkerIdentities.has(workerIdentity)) return undefined;
  const parsedMetadata = parseMetadataRecord(metadata);
  if (parsedMetadata?.["pool_group"] !== group.groupId || parsedMetadata["owner"] !== group.owner) {
    return undefined;
  }
  return {
    workerIdentity,
    profileIdentity,
    workerRole,
    displayName: optionalString(member.display_name) ?? workerIdentity,
    capabilities: optionalString(member.capabilities) ?? "[]",
    metadata,
  };
}

function parseToolPayload(content: ReadonlyArray<ToolCallContentBlock>): ParsedToolPayload {
  const block = content.find((item) => item.type === "text");
  if (block === undefined) return {};
  const parsed = unwrapJsonString(block.text);
  return isRecord(parsed) ? parsed : {};
}

function readMetadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unwrapJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseMetadataRecord(metadata: string): Record<string, unknown> | undefined {
  const parsed = unwrapJsonString(metadata);
  return isRecord(parsed) ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
