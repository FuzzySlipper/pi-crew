/**
 * Local dense profile memory tool wrapper for runtime-local tool creation.
 *
 * Creates the `dense_profile_memory` tool when the store is available
 * and the profile has memory enabled.
 *
 * The inner factory (`createDenseProfileMemoryTool` from @pi-crew/tools)
 * returns `{ name, description, parameters, handler }`. The pi-agent-core
 * AgentTool interface requires `execute` and `label` instead. This wrapper
 * bridges the two protocols.
 *
 * @module pi-crew/dense-profile-memory-tool-local
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { createDenseProfileMemoryTool as createTool } from "@pi-crew/tools";
import type { DenseProfileMemoryStore, DenseMemoryTarget } from "@pi-crew/memory";

export interface CreateLocalDenseProfileMemoryToolInput {
  readonly denseMemoryStore?: DenseProfileMemoryStore;
  readonly profileId: string;
}

export function createLocalDenseProfileMemoryTool(
  input: CreateLocalDenseProfileMemoryToolInput,
): AgentTool {
  const inner = createTool({
    store: input.denseMemoryStore ?? createFallbackStore(input.profileId),
    resolveProfileId: () => input.profileId,
  });

  return {
    name: inner.name,
    label: inner.name,
    description: inner.description,
    parameters: inner.parameters,
    execute: async (_toolCallId, params, _signal) => {
      const result = await inner.handler(params as Record<string, unknown>);
      if (!result.ok) {
        throw new Error(result.error ?? "Dense profile memory operation failed");
      }
      return {
        content: [{ type: "text", text: formatResult(result.data) }] as TextContent[],
        details: result.data ?? {},
      };
    },
  };
}

function formatResult(data: unknown): string {
  if (data === null || data === undefined) return "Operation completed";
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

function createFallbackStore(profileId: string): DenseProfileMemoryStore {
  const emptyContent = (target: DenseMemoryTarget) => ({
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
