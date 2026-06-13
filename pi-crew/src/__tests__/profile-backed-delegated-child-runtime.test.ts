/** Tests for profile-backed delegated child runtime resolution. */

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

class CapturingToolProvider implements ToolProvider {
  resolvedNames: readonly string[] = [];

  resolveTools(toolNames: readonly string[]): AgentTool[] {
    this.resolvedNames = [...toolNames];
    return toolNames.map((name) => ({
      name,
      label: name,
      description: `tool ${name}`,
      parameters: { type: "object", properties: {} },
      execute: () =>
        Promise.resolve({
          content: [{ type: "text", text: `ran ${name}` }],
          details: { ok: true },
        }),
    }));
  }
}

describe("createProfileBackedDelegatedChildRuntimeResolver", () => {
  it("loads child prompt, model config, and tool policy from selected profile", async () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-profile-backed-child-"));
    mkdirSync(join(profilesRoot, "coder-child"));
    writeFileSync(
      join(profilesRoot, "coder-child", "profile.yaml"),
      [
        "name: Coder Child",
        "description: Delegated coder profile",
        "skills: []",
        "modelConfig:",
        "  provider: den-router",
        "  model: coder-profile-model",
        "  baseUrl: http://127.0.0.1:18082/v1",
        "toolPolicy:",
        "  mode: allow_list",
        "  allow:",
        "    - read_file",
        "    - terminal",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(profilesRoot, "coder-child", "soul.md"),
      "PROFILE_SENTINEL_CODER_CHILD_PROMPT\nYou are the profile-backed coder child.",
    );

    const registry = new ToolRegistry(new FakeLogger());
    registry.setMcpTools([mcpTool("read_file"), mcpTool("terminal"), mcpTool("mcp_den_get_task")]);
    const toolProvider = new CapturingToolProvider();
    const resolver = createProfileBackedDelegatedChildRuntimeResolver({
      profilesRoot,
      toolRegistry: registry,
      toolProvider,
      fallbackBaseUrl: "http://127.0.0.1:9999/v1",
    });

    const resolution = await resolver.resolve({
      effectiveRuntime: {
        profileId: "coder-child",
        provider: "fallback-provider",
        model: "fallback-model",
      },
      spawnRequest: { task: "confirm profile sentinel" },
      policy: createExecutionPolicy({
        policyId: "delegated-coder-policy",
        rootPath: "/workspace",
        allowedTools: [],
      }),
      toolFilter: { allowedToolNames: [], deniedToolNames: [] },
    });

    expect(resolution.systemPrompt).toContain("PROFILE_SENTINEL_CODER_CHILD_PROMPT");
    expect(resolution.model?.id).toBe("coder-profile-model");
    expect(resolution.model?.provider).toBe("den-router");
    expect(resolution.effectiveRuntime).toEqual({
      profileId: "coder-child",
      provider: "den-router",
      model: "coder-profile-model",
    });
    expect(toolProvider.resolvedNames).toEqual(["read_file", "terminal"]);
    expect(resolution.tools?.map((tool) => tool.name)).toEqual(["read_file", "terminal"]);
  });

  it("expands coder profile toolsets to Den and local code tools", async () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-profile-backed-tools-"));
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
        "  baseUrl: http://127.0.0.1:18082/v1",
        "toolPolicy:",
        "  mode: allow_list",
        "  allow:",
        "    - filesystem",
        "    - terminal",
        "    - git",
        "    - den",
        "",
      ].join("\n"),
    );
    writeFileSync(join(profilesRoot, "coder-worker", "soul.md"), "Coder prompt.");

    const registry = new ToolRegistry(new FakeLogger());
    registry.setMcpTools([mcpTool("get_task"), mcpTool("search_documents")]);
    const toolProvider = new CapturingToolProvider();
    const resolver = createProfileBackedDelegatedChildRuntimeResolver({
      profilesRoot,
      toolRegistry: registry,
      toolProvider,
      fallbackBaseUrl: "http://127.0.0.1:9999/v1",
    });

    await resolver.resolve({
      effectiveRuntime: { profileId: "coder-worker" },
      spawnRequest: { task: "tool smoke" },
      policy: createExecutionPolicy({
        policyId: "delegated-coder-policy",
        rootPath: "/workspace",
        allowedTools: [],
      }),
      toolFilter: { allowedToolNames: [], deniedToolNames: [] },
    });

    expect(toolProvider.resolvedNames).toEqual([
      "get_task",
      "search_documents",
      "read_file",
      "write_file",
      "search_files",
      "terminal",
      "git_status",
      "git_diff",
    ]);
  });

  it("lets an explicit spawn model override the profile model after policy resolution", async () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-profile-backed-override-"));
    mkdirSync(join(profilesRoot, "reviewer-child"));
    writeFileSync(
      join(profilesRoot, "reviewer-child", "profile.yaml"),
      [
        "name: Reviewer Child",
        "description: Delegated reviewer profile",
        "skills: []",
        "modelConfig:",
        "  provider: den-router",
        "  model: profile-review-model",
        "  baseUrl: http://127.0.0.1:18082/v1",
        "toolPolicy:",
        "  mode: allow_all",
        "",
      ].join("\n"),
    );
    writeFileSync(join(profilesRoot, "reviewer-child", "soul.md"), "Reviewer prompt.");

    const registry = new ToolRegistry(new FakeLogger());
    registry.setMcpTools([mcpTool("get_task")]);
    const resolver = createProfileBackedDelegatedChildRuntimeResolver({
      profilesRoot,
      toolRegistry: registry,
      toolProvider: new CapturingToolProvider(),
      fallbackBaseUrl: "http://127.0.0.1:9999/v1",
    });

    const resolution = await resolver.resolve({
      effectiveRuntime: {
        profileId: "reviewer-child",
        provider: "override-provider",
        model: "override-model",
      },
      spawnRequest: {
        task: "confirm override",
        modelSelection: {
          profileId: "reviewer-child",
          provider: "override-provider",
          model: "override-model",
        },
      },
      policy: createExecutionPolicy({
        policyId: "delegated-review-policy",
        rootPath: "/workspace",
        allowedTools: [],
      }),
      toolFilter: { allowedToolNames: [], deniedToolNames: [] },
    });

    expect(resolution.model?.id).toBe("override-model");
    expect(resolution.model?.provider).toBe("override-provider");
    expect(resolution.effectiveRuntime).toEqual({
      profileId: "reviewer-child",
      provider: "override-provider",
      model: "override-model",
    });
  });
});

function mcpTool(name: string) {
  return {
    name,
    description: `mcp ${name}`,
    inputSchema: { type: "object", properties: {} },
  };
}
