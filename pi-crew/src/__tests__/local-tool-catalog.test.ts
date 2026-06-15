import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DelegatedResult, ExecutionPolicy, Result } from "@pi-crew/core";
import {
  createDelegatedFanOutTool,
  createDelegatedSpawnTool,
  createDelegationHelperTools,
  type DelegatedSpawnError,
  type DelegatedSpawnInput,
  type DelegatedSpawnLifecyclePort,
} from "@pi-crew/service";
import {
  CONTROL_COMMAND_CATALOG,
  LOCAL_MODEL_CALLABLE_TOOL_CATALOG,
  localModelCallableToolNames,
  renderLocalToolCatalogMarkdownTable,
} from "../local-tool-catalog.js";
import { createLocalCodeTools, localCodeToolNames } from "../local-code-tools.js";
import { buildEffectiveToolInventory } from "../tool-inventory.js";

class FakeLifecycle implements DelegatedSpawnLifecyclePort {
  spawn(_input: DelegatedSpawnInput): Promise<Result<DelegatedResult, DelegatedSpawnError>> {
    return Promise.resolve({
      ok: true,
      value: {
        outcome: "success",
        summary: "ok",
        childSessionId: "child",
        policyId: "policy",
      },
    });
  }
}

const parentPolicy: ExecutionPolicy = {
  policyId: "policy",
  rootPath: "/home/dev/pi-crew",
  allowedPaths: ["/home/dev/pi-crew"],
  denyPaths: [],
  allowedTools: [],
  deniedTools: [],
  allowedHosts: [],
  deniedHosts: [],
  credentialScope: "none",
};

function commonDelegationOptions() {
  return {
    lifecycle: new FakeLifecycle(),
    parentSessionId: "parent",
    parentPolicy,
    parentDelegationConstraints: { maxSpawnDepth: 1 },
    parentRuntime: { profileId: "prime", provider: "test", model: "test-model" },
  };
}

describe("local tool catalog", () => {
  it("is the source for local code tool factories", () => {
    expect(localCodeToolNames).toEqual(localModelCallableToolNames("local"));
    expect(createLocalCodeTools().map((tool) => tool.name)).toEqual(
      localModelCallableToolNames("local"),
    );
  });

  it("covers delegation and helper tools assembled for full agents", () => {
    const assembledNames = [
      createDelegatedSpawnTool(commonDelegationOptions()).name,
      createDelegatedFanOutTool(commonDelegationOptions()).name,
      ...createDelegationHelperTools(commonDelegationOptions()).map((tool) => tool.name),
    ];
    const catalogedFullAgentNames = LOCAL_MODEL_CALLABLE_TOOL_CATALOG.filter((entry) =>
      entry.intendedSurfaces.includes("full-agent"),
    ).map((entry) => entry.name);
    expect(catalogedFullAgentNames).toEqual(expect.arrayContaining(assembledNames));
  });

  it("exposes catalog metadata through effective diagnostics inventory", () => {
    const inventory = buildEffectiveToolInventory({
      agent: {
        agentId: "prime",
        enabled: true,
        profileId: "prime",
        profileIdentity: "prime",
        memberIdentity: "prime",
        session: { ownerId: "owner", sessionId: "sess-prime", maxHistoryMessages: 20 },
        channels: [],
        runtime: { mode: "agent", tools: { allow: ["all"] }, toolPolicy: { mode: "profile" } },
        lifecycle: { turnTimeoutMs: 1 },
      },
      profile: {
        id: "prime",
        name: "prime",
        description: "prime",
        systemPrompt: "prime",
        skills: [],
        toolPolicy: { mode: "allow_all" },
      },
      mcpEndpoint: "http://den/mcp",
      mcpTools: [],
      selectedToolNames: new Set(localModelCallableToolNames()),
    });
    expect(inventory.builtInTools.map((tool) => tool.name)).toEqual(localModelCallableToolNames());
    expect(
      inventory.builtInTools.every(
        (tool) => tool.implementedIn.length > 0 && tool.policyGate.length > 0,
      ),
    ).toBe(true);
  });

  it("keeps control commands separate from model-callable tools", () => {
    const toolNames = new Set(localModelCallableToolNames());
    for (const command of CONTROL_COMMAND_CATALOG) {
      expect(command.modelCallable).toBe(false);
      expect(toolNames.has(command.name)).toBe(false);
    }
  });

  it("keeps README local tool table generated from the catalog", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    expect(normalizeMarkdownTable(readme)).toContain(
      normalizeMarkdownTable(renderLocalToolCatalogMarkdownTable()),
    );
  });

  it("requires every cataloged model-callable built-in to name its guardrail test", () => {
    expect(
      LOCAL_MODEL_CALLABLE_TOOL_CATALOG.every((entry) =>
        entry.inventoryTest.endsWith("local-tool-catalog.test.ts"),
      ),
    ).toBe(true);
  });
});

function normalizeMarkdownTable(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .filter((line) => !/^\|[-\s|]+\|$/.test(line.trim()))
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .join("|"),
    )
    .join("\n");
}
