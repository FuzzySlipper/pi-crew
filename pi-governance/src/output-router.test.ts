/**
 * Tests for ToolOutputRouter.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ToolOutputRouter } from "./output-router.js";

describe("ToolOutputRouter", () => {
  let router: ToolOutputRouter;

  beforeEach(() => {
    router = new ToolOutputRouter();
  });

  it("resolves default verbosity for known tools", () => {
    expect(router.resolveVerbosity("write_file")).toBe("summary");
    expect(router.resolveVerbosity("terminal")).toBe("result");
    expect(router.resolveVerbosity("terminal_bg")).toBe("ack");
    expect(router.resolveVerbosity("read_file")).toBe("result");
    expect(router.resolveVerbosity("web_search")).toBe("result");
    expect(router.resolveVerbosity("delegate_task")).toBe("summary");
  });

  it("resolves to result for unknown tools", () => {
    expect(router.resolveVerbosity("nonexistent_tool")).toBe("result");
  });

  it("caps requested verbosity at tool maximum", () => {
    expect(router.resolveVerbosity("write_file", "verbose")).toBe("summary");
    expect(router.resolveVerbosity("terminal_bg", "result")).toBe("ack");
  });

  it("allows lower verbosity than default", () => {
    expect(router.resolveVerbosity("terminal", "summary")).toBe("summary");
    expect(router.resolveVerbosity("read_file", "ack")).toBe("ack");
  });

  it("custom defaults override built-in", () => {
    const custom = new ToolOutputRouter({ write_file: "verbose" });
    expect(custom.resolveVerbosity("write_file")).toBe("verbose");
    expect(custom.resolveVerbosity("terminal")).toBe("result");
  });

  it("route returns both agentContext and auditOutput", () => {
    const result = { exitCode: 0, stdout: "build ok", stderr: "" };
    const routed = router.route("terminal", result, { requestedVerbosity: "ack" });
    expect(routed.auditOutput).toBe(result);
    expect(routed.agentContext).toBeDefined();
    expect(routed.agentContext).not.toBe(result);
  });

  it("ack verbosity gives minimal success output", () => {
    const result = { ok: true, exitCode: 0, stdout: "long output..." };
    const routed = router.route("terminal", result, { requestedVerbosity: "ack" });
    expect(routed.agentContext).toBe("✓ success");
  });

  it("ack verbosity shows failure", () => {
    const result = { ok: false, exitCode: 1 };
    const routed = router.route("terminal", result, { requestedVerbosity: "ack" });
    expect(routed.agentContext).toBe("✗ failed");
  });

  it("summary verbosity shows key fields", () => {
    const result = { success: true, exitCode: 0, toolName: "write_file" };
    const routed = router.route("write_file", result);
    const ctx = routed.agentContext as string;
    expect(ctx).toContain("✓");
    expect(ctx).toContain("exit 0");
  });

  it("verbose returns full result", () => {
    const custom = new ToolOutputRouter({ terminal: "verbose" });
    const result = { exitCode: 0, stdout: "lots of data..." };
    const routed = custom.route("terminal", result);
    expect(routed.agentContext).toBe(result);
  });

  it("trims long string results at summary level", () => {
    const longStr = "x".repeat(300);
    const routed = router.route("unknown_tool", longStr, { requestedVerbosity: "summary" });
    const ctx = routed.agentContext as string;
    expect(ctx.length).toBeLessThanOrEqual(203);
  });

  it("string result at ack level returns done", () => {
    const routed = router.route("unknown_tool", "some output", { requestedVerbosity: "ack" });
    expect(routed.agentContext).toBe("✓ done");
  });

  it("generic object at ack shows truncated keys", () => {
    const result = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    const routed = router.route("unknown_tool", result, { requestedVerbosity: "ack" });
    const ctx = routed.agentContext as string;
    expect(ctx).toContain("{");
    expect(ctx).toContain("...");
  });
});
