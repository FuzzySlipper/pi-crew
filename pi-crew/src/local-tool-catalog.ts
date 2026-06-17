/** Central catalog for pi-crew runtime-local tool and control surfaces. */

export type LocalToolCategory = "delegation" | "helper" | "local" | "planning" | "web" | "browser" | "session" | "memory";
export type LocalToolSurface = "full-agent" | "delegated-child" | "worker";

export interface LocalModelCallableToolCatalogEntry {
  readonly name: string;
  readonly category: LocalToolCategory;
  readonly modelCallable: true;
  readonly implementedIn: string;
  readonly assembledIn: readonly string[];
  readonly intendedSurfaces: readonly LocalToolSurface[];
  readonly policyGate: string;
  readonly inventoryTest: string;
}

export interface ControlCommandCatalogEntry {
  readonly name: string;
  readonly modelCallable: false;
  readonly implementedIn: string;
  readonly surface: "control-plane";
  readonly notes: string;
}

export const LOCAL_MODEL_CALLABLE_TOOL_CATALOG: readonly LocalModelCallableToolCatalogEntry[] = [
  {
    name: "spawn_subagent",
    category: "delegation",
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-spawn-tool.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request delegation or spawn_subagent",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "fan_out_subagents",
    category: "delegation",
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-fan-out-tool.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate:
      "runtime.tools.allow/profile toolPolicy must request delegation or fan_out_subagents",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "scout_codebase",
    category: "helper",
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-helper-tools.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request delegation or scout_codebase",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "summarize_files",
    category: "helper",
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-helper-tools.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request delegation or summarize_files",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "find_relevant_paths",
    category: "helper",
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-helper-tools.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate:
      "runtime.tools.allow/profile toolPolicy must request delegation or find_relevant_paths",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "read_file",
    category: "local",
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    policyGate:
      "runtime.tools.allow/profile toolPolicy must request local, filesystem, or concrete tool name",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "write_file",
    category: "local",
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    policyGate:
      "runtime.tools.allow/profile toolPolicy must request local, filesystem, or concrete tool name",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "search_files",
    category: "local",
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    policyGate:
      "runtime.tools.allow/profile toolPolicy must request local, filesystem, or concrete tool name",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "terminal",
    category: "local",
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    policyGate:
      "runtime.tools.allow/profile toolPolicy must request local, terminal, or concrete tool name",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "git_status",
    category: "local",
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    policyGate:
      "runtime.tools.allow/profile toolPolicy must request local, git, or concrete tool name",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "git_diff",
    category: "local",
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    policyGate:
      "runtime.tools.allow/profile toolPolicy must request local, git, or concrete tool name",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "todo",
    category: "planning",
    modelCallable: true,
    implementedIn: "pi-crew/src/todo-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request planning or todo",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "session_search",
    category: "session",
    modelCallable: true,
    implementedIn: "pi-crew/src/session-search-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request session or session_search",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "web_search",
    category: "web",
    modelCallable: true,
    implementedIn: "pi-crew/src/web-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request web or web_search",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "web_extract",
    category: "web",
    modelCallable: true,
    implementedIn: "pi-crew/src/web-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request web or web_extract",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_recall",
    category: "memory",
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts", "pi-crew/src/agent-worker-executor-factory.ts"],
    intendedSurfaces: ["full-agent", "worker"],
    policyGate: "memory.enabled plus runtime.tools.allow/profile toolPolicy must request memory or den_memory_recall",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_read",
    category: "memory",
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts", "pi-crew/src/agent-worker-executor-factory.ts"],
    intendedSurfaces: ["full-agent", "worker"],
    policyGate: "memory.enabled plus runtime.tools.allow/profile toolPolicy must request memory or den_memory_read",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_search",
    category: "memory",
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts", "pi-crew/src/agent-worker-executor-factory.ts"],
    intendedSurfaces: ["full-agent", "worker"],
    policyGate: "memory.enabled plus runtime.tools.allow/profile toolPolicy must request memory or den_memory_search",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_store",
    category: "memory",
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "memory.enabled plus runtime.tools.allow/profile toolPolicy must request memory or den_memory_store",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_propose",
    category: "memory",
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts", "pi-crew/src/agent-worker-executor-factory.ts"],
    intendedSurfaces: ["full-agent", "worker"],
    policyGate: "memory.enabled plus runtime.tools.allow/profile toolPolicy must request memory or den_memory_propose",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "counter_reset",
    category: "helper",
    modelCallable: true,
    implementedIn: "pi-crew/src/counter-reset-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request helper or counter_reset or backgroundReview.enabled",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "dense_profile_memory",
    category: "memory",
    modelCallable: true,
    implementedIn: "pi-tools/src/dense-profile-memory-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "available when DenseProfileMemoryStore exists (profile memoryConfig not disabled)",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "curator_execute",
    category: "helper",
    modelCallable: true,
    implementedIn: "pi-crew/src/curator-execute-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request helper or curator_execute",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  ...[
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_vision",
    "browser_console",
    "browser_scroll",
    "browser_back",
    "browser_press",
  ].map((name): LocalModelCallableToolCatalogEntry => ({
    name,
    category: "browser",
    modelCallable: true,
    implementedIn: "pi-crew/src/browser-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    policyGate: "runtime.tools.allow/profile toolPolicy must request browser or the concrete browser action",
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  })),
];

export const CONTROL_COMMAND_CATALOG: readonly ControlCommandCatalogEntry[] = [
  {
    name: "/help",
    modelCallable: false,
    implementedIn: "pi-service/src/admin/slash-command-router.ts",
    surface: "control-plane",
    notes: "Lists supported control-plane commands.",
  },
  {
    name: "/status",
    modelCallable: false,
    implementedIn: "pi-service/src/admin/slash-command-router.ts",
    surface: "control-plane",
    notes: "Shows current session diagnostics.",
  },
  {
    name: "/session",
    modelCallable: false,
    implementedIn: "pi-service/src/admin/slash-command-router.ts",
    surface: "control-plane",
    notes: "Alias for /status.",
  },
  {
    name: "/new",
    modelCallable: false,
    implementedIn: "pi-service/src/admin/slash-command-router.ts",
    surface: "control-plane",
    notes: "Resets the full-agent session boundary.",
  },
  {
    name: "/reload-mcp",
    modelCallable: false,
    implementedIn: "pi-service/src/admin/slash-command-router.ts",
    surface: "control-plane",
    notes: "Reloads MCP/tool surface without resetting session history.",
  },
];

export function localModelCallableToolNames(category?: LocalToolCategory): readonly string[] {
  return LOCAL_MODEL_CALLABLE_TOOL_CATALOG.filter(
    (entry) => category === undefined || entry.category === category,
  ).map((entry) => entry.name);
}

export function renderLocalToolCatalogMarkdownTable(): string {
  const lines = [
    "| Tool | Category | Surfaces | Policy gate | Implemented in |",
    "| ---- | -------- | -------- | ----------- | -------------- |",
  ];
  for (const entry of LOCAL_MODEL_CALLABLE_TOOL_CATALOG) {
    lines.push(
      `| \`${entry.name}\` | ${entry.category} | ${entry.intendedSurfaces.join(", ")} | ${entry.policyGate} | \`${entry.implementedIn}\` |`,
    );
  }
  return lines.join("\n");
}
