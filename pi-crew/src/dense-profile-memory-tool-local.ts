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
import type { DenseProfileMemoryStore } from "@pi-crew/memory";

export interface CreateLocalDenseProfileMemoryToolInput {
  readonly denseMemoryStore?: DenseProfileMemoryStore;
  readonly profileId: string;
}

export function createLocalDenseProfileMemoryTool(
  input: CreateLocalDenseProfileMemoryToolInput,
): AgentTool {
  return createTool({
    store: input.denseMemoryStore ?? {
      read: async () => ({
        profileId: input.profileId, target: "memory" as const, content: "",
        capBytes: 2200, usedBytes: 0, writeToken: 0, entryCount: 0,
      }),
      readSync: () => ({
        profileId: input.profileId, target: "memory" as const, content: "",
        capBytes: 2200, usedBytes: 0, writeToken: 0, entryCount: 0,
      }),
      write: async () => ({ success: false, capBytes: 0, usedBytes: 0, newToken: 0, entryCount: 0, driftError: "Dense profile memory store not available" }),
      exportToFilesystem: async () => {},
      importFromFilesystem: async () => {},
    } as unknown as DenseProfileMemoryStore,
    resolveProfileId: () => input.profileId,
  }) as unknown as AgentTool;
}
