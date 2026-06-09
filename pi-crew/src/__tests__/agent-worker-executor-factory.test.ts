import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLogger } from "@pi-crew/core";
import { ToolRegistry, type AgentTool as McpAgentTool, type MCPClient } from "@pi-crew/mcp";
import type { AgentWorkerToolProviderInput } from "@pi-crew/service";

import {
  createCrewAgentWorkerToolProvider,
  createCrewWorkerModelConfigSource,
} from "../agent-worker-executor-factory.js";

function mcpTool(name: string): McpAgentTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
  };
}

function writeProfile(
  root: string,
  profileId: string,
  yaml: string,
  soul = `${profileId} soul.`,
): void {
  const dir = join(root, profileId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.yaml"), yaml, "utf-8");
  writeFileSync(join(dir, "soul.md"), soul, "utf-8");
}

function makeInput(toolSets: readonly string[]): AgentWorkerToolProviderInput {
  return {
    toolSets,
    roleInput: {
      binding: {
        assignmentId: "assignment-1",
        runId: "run-1",
        taskId: "2155",
        projectId: "pi-crew",
        role: "coder",
      },
      sessionId: "session-1",
      profileId: "coder-worker",
    },
  };
}

function makeClient(): MCPClient {
  const client = {
    callTool: () =>
      Promise.resolve({
        ok: true,
        content: [{ type: "text", text: "ok" }],
      }),
  };
  return client as unknown as MCPClient;
}

describe("createCrewAgentWorkerToolProvider", () => {
  it("keeps static control tools but restricts den set to safe read-only MCP tools", () => {
    const registry = new ToolRegistry(new FakeLogger());
    registry.setMcpTools([
      mcpTool("mcp_den_get_task"),
      mcpTool("mcp_den_delete_document"),
      mcpTool("mcp_den_upsert_pool_member"),
      mcpTool("mcp_den_query_librarian"),
      mcpTool("all_dangerous"),
    ]);
    const provider = createCrewAgentWorkerToolProvider({
      mcpClient: makeClient(),
      toolRegistry: registry,
      logger: new FakeLogger(),
    });

    const toolNames = provider(makeInput(["den"])).map((tool) => tool.name);

    expect(toolNames).toContain("post_structured_completion");
    expect(toolNames).toContain("context_status");
    expect(toolNames).toContain("mcp_den_get_task");
    expect(toolNames).toContain("mcp_den_query_librarian");
    expect(toolNames).not.toContain("mcp_den_delete_document");
    expect(toolNames).not.toContain("mcp_den_upsert_pool_member");

    const allToolNames = provider(makeInput(["all"])).map((tool) => tool.name);
    expect(allToolNames).toEqual(["post_structured_completion", "context_status"]);
    const uppercaseAllToolNames = provider(makeInput(["ALL", "All"])).map((tool) => tool.name);
    expect(uppercaseAllToolNames).toEqual(["post_structured_completion", "context_status"]);
  });
});

describe("createCrewWorkerModelConfigSource", () => {
  it("resolves inherited coder and reviewer model config from directory profiles", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-crew-worker-model-config-"));
    writeProfile(
      root,
      "base-worker",
      [
        'name: "Base Worker"',
        'description: "Shared worker defaults"',
        "modelConfig:",
        '  provider: "local-openai-compatible"',
        '  model: "Qwen3.6-35B-A3B-MTP-GGUF"',
        '  baseUrl: "http://192.168.1.23:13305/v1"',
        '  apiKeyEnv: "PI_TEST_LLM_API_KEY"',
        "  maxTokens: 4096",
        "  temperature: 0.1",
        "",
      ].join("\n"),
    );
    writeProfile(
      root,
      "coder-worker",
      [
        "extends: base-worker",
        'name: "Coder Worker"',
        "modelConfig:",
        "  temperature: 0.2",
        "",
      ].join("\n"),
    );
    writeProfile(
      root,
      "reviewer-worker",
      [
        "extends: base-worker",
        'name: "Reviewer Worker"',
        "modelConfig:",
        "  maxTokens: 2048",
        "",
      ].join("\n"),
    );
    const source = createCrewWorkerModelConfigSource({
      logger: new FakeLogger(),
      profilesRoot: root,
      env: { PI_TEST_LLM_API_KEY: "secret-from-env" },
    });

    expect(source.getProfileModelConfig("coder-worker")).toEqual({
      provider: "local-openai-compatible",
      modelName: "Qwen3.6-35B-A3B-MTP-GGUF",
      modelBaseUrl: "http://192.168.1.23:13305/v1",
      temperature: 0.2,
      maxTokens: 4096,
      apiKey: "secret-from-env",
    });
    expect(source.getProfileModelConfig("reviewer-worker")).toMatchObject({
      provider: "local-openai-compatible",
      modelName: "Qwen3.6-35B-A3B-MTP-GGUF",
      modelBaseUrl: "http://192.168.1.23:13305/v1",
      temperature: 0.1,
      maxTokens: 2048,
      apiKey: "secret-from-env",
    });
  });
});
