/** Central catalog for pi-crew runtime-local tool and control surfaces. */

export type LocalToolCategory = "delegation" | "helper" | "local";
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
