/** Tests for profile-owned delegated runtime budgets. */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { ToolRegistry } from "@pi-crew/mcp";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolProvider } from "@pi-crew/service";
import { createExecutionPolicy } from "@pi-crew/tools";
import { createProfileBackedDelegatedChildRuntimeResolver } from "../profile-backed-delegated-child-runtime.js";

class EmptyToolProvider implements ToolProvider {
  resolveTools(_toolNames: readonly string[]): AgentTool[] {
    return [];
  }
}

describe("profile-backed delegated child runtime budgets", () => {
  it("returns max iterations from profile runtime config", async () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-profile-budget-"));
    mkdirSync(join(profilesRoot, "coder-worker"));
    writeFileSync(
      join(profilesRoot, "coder-worker", "profile.yaml"),
      [
        "name: Coder Worker",
        "description: Delegated coder profile",
        "skills: []",
        "modelConfig:",
        "  provider: den-router",
        "  model: coder-profile-model",
        "runtimeConfig:",
        "  maxIterations: 37",
        "  maxTokensPerTurn: 8192",
        "toolPolicy:",
        "  mode: allow_all",
        "",
      ].join("\n"),
    );
    writeFileSync(join(profilesRoot, "coder-worker", "soul.md"), "Coder prompt.");

    const resolver = createProfileBackedDelegatedChildRuntimeResolver({
      profilesRoot,
      toolRegistry: new ToolRegistry(new FakeLogger()),
      toolProvider: new EmptyToolProvider(),
      fallbackBaseUrl: "http://127.0.0.1:9999/v1",
    });

    const resolution = await resolver.resolve({
      effectiveRuntime: { profileId: "coder-worker" },
      spawnRequest: { task: "budget smoke" },
      policy: createExecutionPolicy({
        policyId: "delegated-coder-policy",
        rootPath: "/workspace",
        allowedTools: [],
      }),
      toolFilter: { allowedToolNames: [], deniedToolNames: [] },
    });

    expect(resolution.runtimeConfig).toEqual({
      maxIterations: 37,
      maxTokensPerTurn: 8192,
    });
  });
});
