import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DelegatedResult, ExecutionPolicy, Result } from "@pi-crew/core";
import {
  createDelegatedFanOutTool,
  createDelegatedSpawnTool,
  createDelegationHelperTools,
  type MessageRow,
  type SessionSearchBrowseRow,
  type SessionSearchHit,
  type SessionSearchRepository,
  type DelegatedSpawnError,
  type DelegatedSpawnLifecyclePort,
} from "@pi-crew/service";
import {
  CONTROL_COMMAND_CATALOG,
  LOCAL_MODEL_CALLABLE_TOOL_CATALOG,
  localModelCallableToolNames,
  renderLocalToolCatalogMarkdownTable,
} from "../local-tool-catalog.js";
import { createLocalCodeTools, localCodeToolNames } from "../local-code-tools.js";
import { createRuntimeLocalTools, runtimeLocalToolNames } from "../runtime-local-tools.js";
import { buildEffectiveToolInventory } from "../tool-inventory.js";

class FakeLifecycle implements DelegatedSpawnLifecyclePort {
  spawn(): Promise<Result<DelegatedResult, DelegatedSpawnError>> {
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

const fakeSessionSearchRepository: SessionSearchRepository = {
  searchProfile(): Promise<SessionSearchHit[]> {
    return Promise.resolve([]);
  },
  getSessionMessagesForProfile(): Promise<MessageRow[]> {
    return Promise.resolve([]);
  },
  getWindowForProfile(): Promise<MessageRow[]> {
    return Promise.resolve([]);
  },
  browseProfile(): Promise<SessionSearchBrowseRow[]> {
    return Promise.resolve([]);
  },
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
  it("is the source for runtime-local tool factories", () => {
    expect(runtimeLocalToolNames).toEqual(localModelCallableToolNames());
    expect(new Set(createRuntimeLocalTools({
      sessionId: "sess",
      profileId: "prime",
      sessionSearchRepository: fakeSessionSearchRepository,
    }).map((tool) => tool.name))).toEqual(
      new Set([
        ...localModelCallableToolNames("local"),
        ...localModelCallableToolNames("planning"),
        ...localModelCallableToolNames("session"),
        ...localModelCallableToolNames("web"),
        ...localModelCallableToolNames("browser"),
      ]),
    );
  });

  it("creates memory tools only when Den Memories config is supplied", () => {
    const tools = createRuntimeLocalTools({
      sessionId: "sess",
      profileId: "prime",
      denMemory: {
        baseUrl: "http://den-memory.local",
        policyMode: "manual",
        context: { agentIdentity: "prime", profileId: "prime", sessionId: "sess", sessionKind: "durable_agent" },
      },
    });
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(localModelCallableToolNames("memory")));
  });

  it("keeps local code tool factories category-scoped", () => {
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

  it("reports memory tool inventory as selected or profile-denied", () => {
    const baseAgent = {
      agentId: "prime",
      enabled: true,
      profileId: "prime",
      profileIdentity: "prime",
      memberIdentity: "prime",
      session: { ownerId: "owner", sessionId: "sess-prime", maxHistoryMessages: 20 },
      channels: [],
      runtime: { mode: "agent", systemPromptSource: "profile", tools: { allow: ["memory"] }, toolPolicy: { mode: "profile" } },
      lifecycle: { singleFlight: true, turnTimeoutMs: 1, onStartup: "rehydrate_or_create", onShutdownStatus: "offline" },
    } as const;
    const inventory = buildEffectiveToolInventory({
      agent: baseAgent,
      profile: { id: "prime", name: "prime", description: "prime", systemPrompt: "prime", skills: [], toolPolicy: { mode: "allow_all" } },
      mcpEndpoint: "http://den/mcp",
      mcpTools: [],
      selectedToolNames: new Set(localModelCallableToolNames("memory")),
    });
    expect(inventory.builtInTools.filter((tool) => tool.category === "memory").every((tool) => tool.selected)).toBe(true);

    const denied = buildEffectiveToolInventory({
      agent: baseAgent,
      profile: { id: "prime", name: "prime", description: "prime", systemPrompt: "prime", skills: [], toolPolicy: { mode: "allow_list", allow: ["filesystem"] } },
      mcpEndpoint: "http://den/mcp",
      mcpTools: [],
      selectedToolNames: new Set(),
    });
    expect(denied.builtInTools.find((tool) => tool.name === "den_memory_recall")).toMatchObject({ selected: false, reason: "profile_denied" });
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
