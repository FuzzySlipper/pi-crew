/**
 * Tests for PacketAuditorRoleAssembly — validates the first real
 * Den-backed supervised agent role assembly.
 *
 * Covers:
 * - Role identity
 * - System prompt includes required fields + target packet reference
 * - MCP tool set selection
 * - Drain essential tools
 * - Initial messages with and without target packet reference
 * - Extra hooks return undefined by default
 *
 * @module pi-service/__tests__/workers/packet-auditor-role-assembly
 */

import { describe, it, expect } from "vitest";
import { PacketAuditorRoleAssembly } from "../../workers/packet-auditor-role-assembly.js";
import type { WorkerRoleInput } from "../../workers/worker-role-assembly.js";
import type { WorkerBinding } from "../../sessions/types.js";

// ── Fixtures ─────────────────────────────────────────────────────

function makeBinding(
  overrides?: Partial<WorkerBinding>,
): WorkerBinding {
  return {
    assignmentId: "735",
    runId: "piw_20260607095941_31b9b052",
    taskId: "2049",
    projectId: "pi-crew",
    role: "packet-auditor",
    ...overrides,
  };
}

function makeInput(
  overrides?: Partial<WorkerRoleInput>,
): WorkerRoleInput {
  return {
    binding: makeBinding(),
    sessionId: "sess-test-01",
    profileId: "packet-auditor",
    targetPacketRef: {
      projectId: "pi-crew",
      taskId: "1864",
      runId: "piw_capstone_run",
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("PacketAuditorRoleAssembly", () => {
  // ── Role identity ──────────────────────────────────────────

  it("has role 'packet-auditor'", () => {
    expect(PacketAuditorRoleAssembly.role).toBe("packet-auditor");
  });

  // ── System prompt ──────────────────────────────────────────

  it("buildSystemPrompt includes required field definitions", () => {
    const input = makeInput();
    const prompt = PacketAuditorRoleAssembly.buildSystemPrompt(input);

    expect(prompt).toContain("Packet Auditor");
    expect(prompt).toContain("assignmentId");
    expect(prompt).toContain("runId");
    expect(prompt).toContain("taskId");
    expect(prompt).toContain("artifacts");
    expect(prompt).toContain("filesTouched");
    expect(prompt).toContain("toolsUsed");
    expect(prompt).toContain("tokensConsumed");
    expect(prompt).toContain("durationMs");
    expect(prompt).toContain("turnCount");
    expect(prompt).toContain("role");
    // Valid statuses
    expect(prompt).toContain("completed, failed, blocked, exhausted");
  });

  it("buildSystemPrompt includes target packet reference when provided", () => {
    const input = makeInput();
    const prompt = PacketAuditorRoleAssembly.buildSystemPrompt(input);

    expect(prompt).toContain("Target packet");
    expect(prompt).toContain("pi-crew");
    expect(prompt).toContain("1864");
    expect(prompt).toContain("piw_capstone_run");
  });

  it("buildSystemPrompt omits target packet section when no ref provided", () => {
    const input = makeInput({ targetPacketRef: undefined });
    const prompt = PacketAuditorRoleAssembly.buildSystemPrompt(input);

    expect(prompt).not.toContain("Target packet");
    // Core instructions still present
    expect(prompt).toContain("Packet Auditor");
    expect(prompt).toContain("Required fields");
  });

  it("buildSystemPrompt includes usage guidance", () => {
    const prompt = PacketAuditorRoleAssembly.buildSystemPrompt(
      makeInput(),
    );

    expect(prompt).toContain("post_structured_completion");
    expect(prompt).toContain("Read-only");
    expect(prompt).toContain("structured failure");
  });

  // ── MCP tool sets ──────────────────────────────────────────

  it("selectMcpToolSets returns den tool set", () => {
    const sets = PacketAuditorRoleAssembly.selectMcpToolSets(makeInput());

    expect(sets).toEqual(["den"]);
  });

  it("selectMcpToolSets is stable across different inputs", () => {
    const a = makeInput();
    const b = makeInput({ targetPacketRef: undefined });

    expect(PacketAuditorRoleAssembly.selectMcpToolSets(a)).toEqual(
      PacketAuditorRoleAssembly.selectMcpToolSets(b),
    );
  });

  // ── Drain essential tools ──────────────────────────────────

  it("drainEssentialTools returns context_status and structured completion", () => {
    const tools = PacketAuditorRoleAssembly.drainEssentialTools(
      makeInput(),
    );

    expect(tools).toContain("context_status");
    expect(tools).toContain("post_structured_completion");
  });

  it("drainEssentialTools is stable across different inputs", () => {
    const a = makeInput();
    const b = makeInput({ targetPacketRef: undefined });

    expect(
      PacketAuditorRoleAssembly.drainEssentialTools(a),
    ).toEqual(PacketAuditorRoleAssembly.drainEssentialTools(b));
  });

  // ── Initial messages ───────────────────────────────────────

  it("buildInitialMessages returns a single user message with packet ref", () => {
    const messages = PacketAuditorRoleAssembly.buildInitialMessages(
      makeInput(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    const content = (messages[0] as { content: string }).content;
    expect(content).toContain("piw_capstone_run");
    expect(content).toContain("pi-crew");
    expect(content).toContain("1864");
    expect(content).toContain("validate all required fields");
  });

  it("buildInitialMessages returns a generic message when no target packet ref", () => {
    const input = makeInput({ targetPacketRef: undefined });
    const messages =
      PacketAuditorRoleAssembly.buildInitialMessages(input);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    const content = (messages[0] as { content: string }).content;
    expect(content).toContain("Audit the completion packet assigned to this worker session");
    expect(content).not.toContain("piw_capstone_run");
  });

  it("buildInitialMessages has a timestamp", () => {
    const before = Date.now();
    const messages = PacketAuditorRoleAssembly.buildInitialMessages(
      makeInput(),
    );
    const after = Date.now();

    expect(messages).toHaveLength(1);
    const msg = messages[0] as { timestamp: number };
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  // ── Extra hooks ────────────────────────────────────────────

  it("extraHooks returns undefined by default", () => {
    const hooks = PacketAuditorRoleAssembly.extraHooks?.(makeInput());

    expect(hooks).toBeUndefined();
  });

  // ── Profile/tool assembly behavior ─────────────────────────

  it("system prompt includes all valid statuses", () => {
    const prompt = PacketAuditorRoleAssembly.buildSystemPrompt(
      makeInput(),
    );

    expect(prompt).toContain("completed");
    expect(prompt).toContain("failed");
    expect(prompt).toContain("blocked");
    expect(prompt).toContain("exhausted");
  });

  it("buildSystemPrompt with roleConfig maintains core instructions", () => {
    const input = makeInput({
      roleConfig: {
        modelProvider: "deepseek",
        mcpToolSet: ["den"],
        drainEssentialTools: ["context_status"],
      },
    });
    const prompt = PacketAuditorRoleAssembly.buildSystemPrompt(input);

    // Core instructions still present regardless of roleConfig
    expect(prompt).toContain("Packet Auditor");
    expect(prompt).toContain("Required fields");
    expect(prompt).toContain("assignmentId");
  });

  it("buildInitialMessages with roleConfig still produces valid messages", () => {
    const input = makeInput({
      roleConfig: {
        modelProvider: "deepseek",
        mcpToolSet: ["den"],
      },
    });
    const messages =
      PacketAuditorRoleAssembly.buildInitialMessages(input);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    const content = (messages[0] as { content: string }).content;
    expect(content).toContain("piw_capstone_run");
  });
});
