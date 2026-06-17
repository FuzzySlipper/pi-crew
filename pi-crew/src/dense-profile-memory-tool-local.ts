/**
 * Local dense profile memory tool wrapper for runtime-local tool creation.
 *
 * Creates the `dense_profile_memory` tool when the store is available
 * and the profile has memory enabled.
 *
 * @module pi-crew/dense-profile-memory-tool-local
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createDenseProfileMemoryTool as createTool } from "@pi-crew/tools";
import type { DenseProfileMemoryStore, DenseMemoryTarget, DenseMemoryContent } from "@pi-crew/memory";

export interface CreateLocalDenseProfileMemoryToolInput {
  readonly denseMemoryStore?: DenseProfileMemoryStore;
  readonly profileId: string;
}

export function createLocalDenseProfileMemoryTool(
  input: CreateLocalDenseProfileMemoryToolInput,
): AgentTool {
  return createTool({
    store: input.denseMemoryStore ?? createFallbackStore(input.profileId),
    resolveProfileId: () => input.profileId,
  }) as unknown as AgentTool;
}

function createFallbackStore(profileId: string): DenseProfileMemoryStore {
  const emptyContent = (target: DenseMemoryTarget): DenseMemoryContent => ({
    profileId,
    target,
    content: "",
    capBytes: 2200,
    usedBytes: 0,
    writeToken: 0,
    entryCount: 0,
  });

  return {
    read: async (_profileId: string, target: DenseMemoryTarget) =>
      emptyContent(target),
    readSync: (_profileId: string, target: DenseMemoryTarget) =>
      emptyContent(target),
    write: async () => ({
      success: false,
      capBytes: 2200,
      usedBytes: 0,
      newToken: 0,
      entryCount: 0,
      driftError: "Dense profile memory store not available. Enable memory in the profile or pass a configured store.",
    }),
    exportToFilesystem: async () => {},
    importFromFilesystem: async () => {},
  };
}
