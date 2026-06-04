// pi-tools — Purpose-built tool implementations for pi-crew agents.
// Depends on: pi-core

import type { Result } from "@pi-crew/core";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<Result<unknown>>;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): string[];
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      tools.set(tool.name, tool);
    },
    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },
    list(): string[] {
      return [...tools.keys()];
    },
  };
}
