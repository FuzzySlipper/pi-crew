/** Tests for CoderRoleAssembly — supervised Agent role configuration. */

import { describe, expect, it } from "vitest";
import { CoderRoleAssembly } from "../../workers/role-assembly-coder.js";
import type { WorkerRoleInput } from "../../workers/worker-role-assembly.js";
import type { WorkerBinding } from "../../sessions/types.js";

function makeBinding(overrides?: Partial<WorkerBinding>): WorkerBinding {
  return {
    assignmentId: "981",
    runId: "piw_coder_run",
    taskId: "2098",
    projectId: "pi-crew",
    role: "coder",
    ...overrides,
  };
}

function makeInput(overrides?: Partial<WorkerRoleInput>): WorkerRoleInput {
  return {
    binding: makeBinding(),
    sessionId: "session-coder-01",
    profileId: "spawned-coder",
    roleConfig: {
      systemPromptSource: "spawned-coder",
    },
    ...overrides,
  };
}

describe("CoderRoleAssembly", () => {
  it("identifies the coder role", () => {
    expect(CoderRoleAssembly.role).toBe("coder");
  });

  it("builds a system prompt from profile and Den assignment context", () => {
    const prompt = CoderRoleAssembly.buildSystemPrompt(makeInput());

    expect(prompt).toContain("Coder");
    expect(prompt).toContain("spawned-coder");
    expect(prompt).toContain("pi-crew");
    expect(prompt).toContain("2098");
    expect(prompt).toContain("piw_coder_run");
    expect(prompt).toContain("implementation_packet");
    expect(prompt).toContain("Den");
  });

  it("selects filesystem terminal git and Den MCP tool sets by default", () => {
    expect(CoderRoleAssembly.selectMcpToolSets(makeInput())).toEqual([
      "filesystem",
      "terminal",
      "git",
      "den",
    ]);
  });

  it("uses configured MCP tool sets when supplied by role config", () => {
    const sets = CoderRoleAssembly.selectMcpToolSets(
      makeInput({
        roleConfig: {
          mcpToolSet: ["den", "terminal"],
        },
      }),
    );

    expect(sets).toEqual(["den", "terminal"]);
  });

  it("keeps context status and structured completion as drain essentials", () => {
    const tools = CoderRoleAssembly.drainEssentialTools(makeInput());

    expect(tools).toEqual([
      "context_status",
      "post_structured_completion",
    ]);
  });

  it("includes Den assignment context in the initial user message", () => {
    const messages = CoderRoleAssembly.buildInitialMessages(makeInput());

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message).toBeDefined();
    if (message === undefined) throw new Error("expected a message");
    expect(message.role).toBe("user");
    expect(typeof message.content).toBe("string");
    if (typeof message.content !== "string") throw new Error("expected text content");
    expect(message.content).toContain("coder_context_packet");
    expect(message.content).toContain("assignmentId: 981");
    expect(message.content).toContain("runId: piw_coder_run");
    expect(message.content).toContain("taskId: 2098");
    expect(message.content).toContain("projectId: pi-crew");
    expect(message.content).toContain("post_structured_completion");
  });
});
