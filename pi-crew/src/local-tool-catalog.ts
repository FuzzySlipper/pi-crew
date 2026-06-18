/** Central catalog for pi-crew runtime-local tool and control surfaces. */

export type LocalToolCategory = "delegation" | "helper" | "local" | "planning" | "web" | "browser" | "session" | "memory" | "skills";
export type LocalToolSurface = "full-agent" | "delegated-child" | "worker";

export interface LocalModelCallableToolCatalogEntry {
  readonly name: string;
  readonly category: LocalToolCategory;
  /** Ordered list of set names this tool belongs to (e.g. ["filesystem", "local"]). */
  readonly toolsets: readonly string[];
  readonly modelCallable: true;
  readonly implementedIn: string;
  readonly assembledIn: readonly string[];
  readonly intendedSurfaces: readonly LocalToolSurface[];
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
    name: "patch",
    category: "local",
    toolsets: ["filesystem", "local"],
    modelCallable: true,
    implementedIn: "pi-crew/src/patch-tool.ts",
    assembledIn: [
      "pi-crew/src/local-code-tools.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "spawn_subagent",
    category: "delegation",
    toolsets: ["delegation"],
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-spawn-tool.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "fan_out_subagents",
    category: "delegation",
    toolsets: ["delegation"],
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-fan-out-tool.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "scout_codebase",
    category: "helper",
    toolsets: ["delegation", "helper"],
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-helper-tools.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "summarize_files",
    category: "helper",
    toolsets: ["delegation", "helper"],
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-helper-tools.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "find_relevant_paths",
    category: "helper",
    toolsets: ["delegation", "helper"],
    modelCallable: true,
    implementedIn: "pi-service/src/workers/delegated-helper-tools.ts",
    assembledIn: ["pi-crew/src/full-agent-runtime-assembly.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "read_file",
    category: "local",
    toolsets: ["filesystem", "filesystem_readonly", "local"],
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "write_file",
    category: "local",
    toolsets: ["filesystem", "local"],
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "search_files",
    category: "local",
    toolsets: ["filesystem", "filesystem_readonly", "local"],
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "terminal",
    category: "local",
    toolsets: ["local", "terminal"],
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "git_status",
    category: "local",
    toolsets: ["git", "git_diff_log", "local"],
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "git_diff",
    category: "local",
    toolsets: ["git", "git_diff_log", "local"],
    modelCallable: true,
    implementedIn: "pi-crew/src/local-code-tools.ts",
    assembledIn: [
      "pi-crew/src/full-agent-tool-selection.ts",
      "pi-crew/src/profile-backed-delegated-child-runtime.ts",
    ],
    intendedSurfaces: ["full-agent", "delegated-child"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "todo",
    category: "planning",
    toolsets: ["planning"],
    modelCallable: true,
    implementedIn: "pi-crew/src/todo-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "session_search",
    category: "session",
    toolsets: ["session"],
    modelCallable: true,
    implementedIn: "pi-crew/src/session-search-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "web_search",
    category: "web",
    toolsets: ["web"],
    modelCallable: true,
    implementedIn: "pi-crew/src/web-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "web_extract",
    category: "web",
    toolsets: ["web"],
    modelCallable: true,
    implementedIn: "pi-crew/src/web-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_recall",
    category: "memory",
    toolsets: ["memory"],
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts", "pi-crew/src/agent-worker-executor-factory.ts"],
    intendedSurfaces: ["full-agent", "worker"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_read",
    category: "memory",
    toolsets: ["memory"],
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts", "pi-crew/src/agent-worker-executor-factory.ts"],
    intendedSurfaces: ["full-agent", "worker"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_search",
    category: "memory",
    toolsets: ["memory"],
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts", "pi-crew/src/agent-worker-executor-factory.ts"],
    intendedSurfaces: ["full-agent", "worker"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_store",
    category: "memory",
    toolsets: ["memory"],
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "den_memory_propose",
    category: "memory",
    toolsets: ["memory"],
    modelCallable: true,
    implementedIn: "pi-crew/src/den-memory-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts", "pi-crew/src/agent-worker-executor-factory.ts"],
    intendedSurfaces: ["full-agent", "worker"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "counter_reset",
    category: "helper",
    toolsets: ["helper"],
    modelCallable: true,
    implementedIn: "pi-crew/src/counter-reset-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "dense_profile_memory",
    category: "memory",
    toolsets: ["memory"],
    modelCallable: true,
    implementedIn: "pi-tools/src/dense-profile-memory-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "curator_execute",
    category: "helper",
    toolsets: ["helper"],
    modelCallable: true,
    implementedIn: "pi-crew/src/curator-execute-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "skills_list",
    category: "skills",
    toolsets: ["skills"],
    modelCallable: true,
    implementedIn: "pi-crew/src/skills-list-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "skill_view",
    category: "skills",
    toolsets: ["skills"],
    modelCallable: true,
    implementedIn: "pi-crew/src/skill-view-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  {
    name: "skill_manage",
    category: "skills",
    toolsets: ["skills"],
    modelCallable: true,
    implementedIn: "pi-crew/src/skill-manage-tool.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
    inventoryTest: "pi-crew/src/__tests__/local-tool-catalog.test.ts",
  },
  ...(["browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_vision",
    "browser_console",
    "browser_scroll",
    "browser_back",
    "browser_press",
  ] as const).map((name): LocalModelCallableToolCatalogEntry => ({
    name,
    category: "browser",
    toolsets: ["browser"],
    modelCallable: true,
    implementedIn: "pi-crew/src/browser-tools.ts",
    assembledIn: ["pi-crew/src/runtime-local-tools.ts"],
    intendedSurfaces: ["full-agent"],
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
    "| Tool | Category | Toolsets | Surfaces | Implemented in |",
    "| ---- | -------- | -------- | -------- | -------------- |",
  ];
  for (const entry of LOCAL_MODEL_CALLABLE_TOOL_CATALOG) {
    lines.push(
      `| \`${entry.name}\` | ${entry.category} | ${entry.toolsets.join(", ")} | ${entry.intendedSurfaces.join(", ")} | \`${entry.implementedIn}\` |`,
    );
  }
  return lines.join("\n");
}

/**
 * Derive the set-membership registry from the catalog.
 *
 * Each catalog entry's `toolsets` array declares which named sets the tool
 * belongs to. This function collects the reverse mapping: set name → tool names.
 * This is the single source of truth.
 */
export function buildToolSetRegistry(): Readonly<Record<string, ReadonlySet<string>>> {
  const registry: Record<string, Set<string>> = {};
  for (const entry of LOCAL_MODEL_CALLABLE_TOOL_CATALOG) {
    for (const setName of entry.toolsets) {
      if (registry[setName] === undefined) registry[setName] = new Set();
      registry[setName].add(entry.name);
    }
  }
  return Object.fromEntries(
    Object.entries(registry).map(([key, value]) => [key, value]),
  );
}
