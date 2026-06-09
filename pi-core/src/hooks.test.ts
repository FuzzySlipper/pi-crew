import { describe, expect, it } from "vitest";
import type { HookPayload } from "./hooks.js";
import { InMemoryHookRegistry } from "./hooks.js";
import { FakeLogger } from "./test-helpers/fake-logger.js";

describe("InMemoryHookRegistry", () => {
  it("short-circuits gate hooks on the first veto", async () => {
    const registry = new InMemoryHookRegistry();
    const calls: string[] = [];

    registry.register("before_tool_call", () => {
      calls.push("first");
      return { proceed: true };
    }, { name: "first", priority: 10 });

    registry.register("before_tool_call", () => {
      calls.push("second");
      return { proceed: false, reason: "blocked by policy" };
    }, { name: "second", priority: 20 });

    registry.register("before_tool_call", () => {
      calls.push("third");
      return { proceed: true };
    }, { name: "third", priority: 30 });

    const result = await registry.fire("before_tool_call", {
      sessionId: "s1",
      toolName: "terminal",
      toolCallId: "tc1",
      args: { command: "date" },
    });

    expect(result).toEqual({ proceed: false, reason: "blocked by policy" });
    expect(calls).toEqual(["first", "second"]);
  });

  it("merges modifier hook results in priority order", async () => {
    const registry = new InMemoryHookRegistry();

    registry.register("agent_context_inject", () => ({
      contextAppend: "alpha",
      env: { FIRST: "1", SHARED: "first" },
    }), { name: "first", priority: 20 });

    registry.register("agent_context_inject", () => ({
      contextAppend: "beta",
      env: { SECOND: "2", SHARED: "second" },
    }), { name: "second", priority: 10 });

    const result = await registry.fire("agent_context_inject", {
      sessionId: "s1",
      profileId: "runner",
      workdir: "/tmp/work",
    });

    expect(result).toEqual({
      contextAppend: "beta\nalpha",
      env: { FIRST: "1", SECOND: "2", SHARED: "first" },
    });
  });

  it("isolates observer hook errors and logs them", async () => {
    const logger = new FakeLogger();
    const registry = new InMemoryHookRegistry(logger);
    const calls: string[] = [];

    registry.register("after_message_send", () => {
      calls.push("first");
      throw new TypeError("observer failed");
    }, { name: "throwing-observer", priority: 10 });

    registry.register("after_message_send", () => {
      calls.push("second");
    }, { name: "second", priority: 20 });

    await registry.fire("after_message_send", {
      channelId: "channel-1",
      sessionId: "s1",
      messageId: "m1",
    });

    expect(calls).toEqual(["first", "second"]);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe("warn");
    expect(logger.entries[0]?.message).toContain("Hook handler failed");
    expect(logger.entries[0]?.context).toMatchObject({
      hook: "after_message_send",
      handler: "throwing-observer",
    });
  });

  it("runs same-priority handlers in registration order", async () => {
    const registry = new InMemoryHookRegistry();
    const calls: string[] = [];

    registry.register("before_session_create", () => {
      calls.push("first");
      return { proceed: true };
    }, { name: "first", priority: 10 });

    registry.register("before_session_create", () => {
      calls.push("second");
      return { proceed: true };
    }, { name: "second", priority: 10 });

    await registry.fire("before_session_create", {
      profileId: "runner",
      kind: "worker",
      channelBindings: ["channel-1"],
    });

    expect(calls).toEqual(["first", "second"]);
  });

  it("unregisters handlers", async () => {
    const registry = new InMemoryHookRegistry();
    const calls: string[] = [];

    const unregister = registry.register("before_message_send", () => {
      calls.push("removed");
      return { proceed: false, reason: "should not run" };
    }, { name: "removed" });
    unregister();

    registry.register("before_message_send", () => {
      calls.push("kept");
      return { proceed: true };
    }, { name: "kept" });

    const result = await registry.fire("before_message_send", {
      channelId: "channel-1",
      sessionId: "s1",
      content: { kind: "text", text: "hello" },
    });

    expect(result).toEqual({ proceed: true });
    expect(calls).toEqual(["kept"]);
  });

  it("checks hook payload types by hook name at compile time", () => {
    type BeforeToolCall = HookPayload<"before_tool_call">;
    const validPayload: BeforeToolCall = {
      sessionId: "s1",
      toolName: "terminal",
      toolCallId: "tc1",
      args: {},
    };

    expect(validPayload.toolName).toBe("terminal");

    compileTimeOnly(() => {
      const registry = new InMemoryHookRegistry();
      // @ts-expect-error before_tool_call payload requires toolName and toolCallId.
      void registry.fire("before_tool_call", { sessionId: "s1", args: {} });
      // @ts-expect-error before_session_create does not carry a toolName field.
      void registry.fire("before_session_create", { profileId: "p1", kind: "worker", channelBindings: [], toolName: "terminal" });
    });
  });
});

function compileTimeOnly(callback: () => void): void {
  // This helper intentionally does not call the callback; it gives TypeScript
  // a place to check compile-time-only examples without runtime side effects.
  void callback;
}
