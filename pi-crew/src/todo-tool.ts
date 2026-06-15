import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
}

export interface TodoToolStore {
  read(sessionId: string): readonly TodoItem[];
  write(sessionId: string, todos: readonly TodoItem[], merge: boolean): readonly TodoItem[];
  contextMessage(sessionId: string): AgentMessage | null;
}

const TODO_STATUSES = new Set<string>(["pending", "in_progress", "completed", "cancelled"]);
const STORES = new Map<string, TodoItem[]>();

export class InMemoryTodoToolStore implements TodoToolStore {
  read(sessionId: string): readonly TodoItem[] {
    return [...(STORES.get(sessionId) ?? [])];
  }

  write(sessionId: string, todos: readonly TodoItem[], merge: boolean): readonly TodoItem[] {
    const next = merge ? mergeTodos(this.read(sessionId), todos) : [...todos];
    STORES.set(sessionId, next.map((item) => ({ ...item })));
    return this.read(sessionId);
  }

  contextMessage(sessionId: string): AgentMessage | null {
    const todos = this.read(sessionId);
    if (todos.length === 0) return null;
    return {
      role: "user",
      content: [
        "[Session todo list]",
        "This is volatile session planning state from the model-callable todo tool, not Den task truth.",
        ...todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`),
      ].join("\n"),
      timestamp: Date.now(),
    };
  }
}

export function createTodoTool(input: {
  readonly sessionId: string;
  readonly store?: TodoToolStore;
}): AgentTool {
  const store = input.store ?? new InMemoryTodoToolStore();
  return {
    label: "Todo list",
    name: "todo",
    description:
      "Manage a volatile session-scoped task list. Omit todos to read. Provide todos to replace the list, or merge=true to update by id. Always returns the full current list. Den tasks remain the durable workflow source of truth.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        todos: {
          type: "array",
          description: "Optional full todo list to write. Omit to read current list.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: [...TODO_STATUSES] },
            },
            required: ["id", "content", "status"],
          },
        },
        merge: {
          type: "boolean",
          default: false,
          description: "When true, update existing items by id and append new items. False replaces the list.",
        },
      },
      required: [],
    },
    execute: async (_toolCallId, params) => {
      await Promise.resolve();
      const maybeTodos = todoArrayParam(params, "todos");
      const current = maybeTodos === undefined
        ? store.read(input.sessionId)
        : store.write(input.sessionId, maybeTodos, booleanParam(params, "merge", false));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ todos: current }, null, 2) }],
        details: { ok: true, todos: current },
      };
    },
  };
}

export function todoContextMessage(sessionId: string, store: TodoToolStore = new InMemoryTodoToolStore()): AgentMessage | null {
  return store.contextMessage(sessionId);
}

function mergeTodos(existing: readonly TodoItem[], updates: readonly TodoItem[]): TodoItem[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of updates) byId.set(item.id, item);
  return [...byId.values()];
}

function todoArrayParam(params: unknown, name: string): readonly TodoItem[] | undefined {
  const value = objectParam(params)[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value.map(todoParam);
}

function todoParam(value: unknown): TodoItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("todo item must be an object");
  }
  const record = value as Record<string, unknown>;
  const id = stringField(record, "id");
  const content = stringField(record, "content");
  const status = stringField(record, "status");
  if (!TODO_STATUSES.has(status)) throw new TypeError(`invalid todo status: ${status}`);
  return { id, content, status: status as TodoStatus };
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`todo.${name} must be a non-empty string`);
  }
  return value;
}

function booleanParam(params: unknown, name: string, fallback: boolean): boolean {
  const value = objectParam(params)[name];
  return typeof value === "boolean" ? value : fallback;
}

function objectParam(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
