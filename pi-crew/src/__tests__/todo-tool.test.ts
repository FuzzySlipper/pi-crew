import { describe, expect, it } from "vitest";
import { createTodoTool, InMemoryTodoToolStore } from "../todo-tool.js";

describe("todo tool", () => {
  it("reads, replaces, merges, and reinjects session-local todo context", async () => {
    const store = new InMemoryTodoToolStore();
    const tool = createTodoTool({ sessionId: "sess-a", store });

    expect(await execute(tool, {})).toEqual({ todos: [] });
    expect(await execute(tool, { todos: [{ id: "one", content: "First", status: "pending" }] })).toEqual({
      todos: [{ id: "one", content: "First", status: "pending" }],
    });
    expect(await execute(tool, { merge: true, todos: [{ id: "one", content: "First", status: "completed" }, { id: "two", content: "Second", status: "in_progress" }] })).toEqual({
      todos: [
        { id: "one", content: "First", status: "completed" },
        { id: "two", content: "Second", status: "in_progress" },
      ],
    });

    const context = store.contextMessage("sess-a");
    expect(JSON.stringify(context)).toContain("[completed] one: First");
    expect(store.read("sess-b")).toEqual([]);
  });
});

async function execute(tool: ReturnType<typeof createTodoTool>, params: unknown): Promise<unknown> {
  const result = await tool.execute("call", params);
  const content = result.content[0] as { readonly text?: string } | undefined;
  return JSON.parse(content?.text ?? "{}") as unknown;
}
