/**
 * Tests for WorkerRoleMappingConfig — zod validation and runtime resolution.
 *
 * Covers:
 *   - Valid mappings with single and multiple roles
 *   - Missing role field
 *   - Missing profileId field
 *   - Empty bindings array
 *   - Duplicate role rejection
 *   - resolveProfileId for known and unknown roles
 *   - resolveRoleConfig for config and no-config bindings
 *   - Concrete role examples: coder, reviewer, packet-auditor, validator
 *   - No accidental fallback profile
 *
 * @module pi-service/__tests__/workers/worker-role-config
 */

import { describe, it, expect } from "vitest";
import {
  WorkerRoleBindingSchema,
  WorkerRoleMappingConfigSchema,
  DEFAULT_WORKER_ROLE_BINDINGS,
  loadWorkerRoleMapping,
  resolveProfileId,
  resolveRoleConfig,
} from "../../workers/worker-role-config.js";

// ── Valid mapping helpers ──────────────────────────────────────

function makeValidMapping(
  bindings = DEFAULT_WORKER_ROLE_BINDINGS,
) {
  return { bindings };
}

function withBinding(overrides: {
  readonly role: string;
  readonly profileId: string;
  readonly config?: Record<string, unknown>;
}) {
  return makeValidMapping(
    DEFAULT_WORKER_ROLE_BINDINGS.map((binding) =>
      binding.role === overrides.role ? { ...binding, ...overrides } : binding,
    ),
  );
}

// ── Single binding schema ──────────────────────────────────────

describe("WorkerRoleBindingSchema", () => {
  it("accepts valid role + profileId", () => {
    const result = WorkerRoleBindingSchema.safeParse({
      role: "coder",
      profileId: "spawned-coder",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("coder");
      expect(result.data.profileId).toBe("spawned-coder");
    }
  });

  it("rejects empty role string", () => {
    const result = WorkerRoleBindingSchema.safeParse({
      role: "",
      profileId: "spawned-coder",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty profileId string", () => {
    const result = WorkerRoleBindingSchema.safeParse({
      role: "coder",
      profileId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects llmAgent execution when deterministicMode is also enabled", () => {
    const result = WorkerRoleBindingSchema.safeParse({
      role: "coder",
      profileId: "spawned-coder",
      config: {
        executionMode: "llmAgent",
        deterministicMode: true,
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("cannot also enable deterministicMode");
  });

  it("accepts binding with optional config", () => {
    const result = WorkerRoleBindingSchema.safeParse({
      role: "coder",
      profileId: "spawned-coder",
      config: {
        executionMode: "llmAgent",
        modelProvider: "local-openai-compatible",
        modelName: "Qwen3.6-35B-A3B-MTP-GGUF",
        modelBaseUrl: "http://192.168.1.23:13305/v1",
        temperature: 0.2,
        maxTokens: 4096,
        systemPromptSource: "spawned-coder",
        mcpToolSet: ["file", "terminal"],
        drainEssentialTools: ["health"],
        deterministicMode: false,
        toolPolicyDefaults: {
          allowedTools: ["write_file", "terminal"],
          deniedTools: ["send_message"],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config?.executionMode).toBe("llmAgent");
      expect(result.data.config?.modelBaseUrl).toBe("http://192.168.1.23:13305/v1");
      expect(result.data.config?.mcpToolSet).toEqual(["file", "terminal"]);
      expect(result.data.config?.deterministicMode).toBe(false);
      expect(result.data.config?.toolPolicyDefaults?.allowedTools).toEqual([
        "write_file",
        "terminal",
      ]);
    }
  });
});

// ── Full mapping validation ────────────────────────────────────

describe("WorkerRoleMappingConfigSchema", () => {
  it("accepts valid multi-role mapping", () => {
    const result = WorkerRoleMappingConfigSchema.safeParse(
      makeValidMapping(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bindings).toHaveLength(6);
    }
  });

  it("rejects mappings missing required worker roles", () => {
    const result = WorkerRoleMappingConfigSchema.safeParse({
      bindings: [{ role: "packet-auditor", profileId: "packet-auditor" }],
    });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((i) => i.message) ?? [];
    expect(messages).toContain(
      'Missing worker role binding for required role "coder"',
    );
  });

  it("rejects empty bindings array", () => {
    const result = WorkerRoleMappingConfigSchema.safeParse({
      bindings: [],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "At least one worker role binding is required",
    );
  });

  it("rejects duplicate roles", () => {
    const result = WorkerRoleMappingConfigSchema.safeParse({
      bindings: [
        { role: "coder", profileId: "spawned-coder" },
        { role: "coder", profileId: "spawned-coder-v2" },
      ],
    });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((i) => i.message) ?? [];
    const dupMsg = messages.find((m) => m.includes("Duplicate role"));
    expect(dupMsg).toBeDefined();
    expect(dupMsg).toContain("coder");
  });

  it("flags the second occurrence in duplicate path", () => {
    const result = WorkerRoleMappingConfigSchema.safeParse({
      bindings: [
        { role: "packet-auditor", profileId: "pa-1" },
        { role: "coder", profileId: "c-1" },
        { role: "packet-auditor", profileId: "pa-2" },
      ],
    });
    expect(result.success).toBe(false);
    // The duplicate error should be on the third binding (index 2)
    const dupIssue = result.error?.issues.find(
      (i) => i.path[0] === "bindings" && i.path[1] === 2,
    );
    expect(dupIssue).toBeDefined();
  });

  it("rejects missing role field", () => {
    const result = WorkerRoleMappingConfigSchema.safeParse({
      bindings: [{ profileId: "spawned-coder" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing profileId field", () => {
    const result = WorkerRoleMappingConfigSchema.safeParse({
      bindings: [{ role: "coder" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing bindings key entirely", () => {
    const result = WorkerRoleMappingConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── loadWorkerRoleMapping convenience ──────────────────────────

describe("loadWorkerRoleMapping", () => {
  it("returns parsed mapping for valid input", () => {
    const mapping = loadWorkerRoleMapping(makeValidMapping());
    expect(mapping.bindings).toHaveLength(6);
    expect(resolveProfileId(mapping, "coder")).toBe("spawned-coder");
  });

  it("throws ConfigurationError for duplicate roles", () => {
    expect(() =>
      loadWorkerRoleMapping({
        bindings: [
          { role: "coder", profileId: "a" },
          { role: "coder", profileId: "b" },
        ],
      }),
    ).toThrow("Invalid worker role mapping configuration");
  });

  it("throws ConfigurationError for empty bindings", () => {
    expect(() =>
      loadWorkerRoleMapping({ bindings: [] }),
    ).toThrow("Invalid worker role mapping configuration");
  });
});

// ── resolveProfileId runtime resolution ────────────────────────

describe("resolveProfileId", () => {
  const mapping = loadWorkerRoleMapping(makeValidMapping());

  it("resolves coder → spawned-coder", () => {
    expect(resolveProfileId(mapping, "coder")).toBe("spawned-coder");
  });

  it("resolves reviewer → spawned-reviewer", () => {
    expect(resolveProfileId(mapping, "reviewer")).toBe("spawned-reviewer");
  });

  it("resolves packet-auditor → packet-auditor", () => {
    expect(resolveProfileId(mapping, "packet-auditor")).toBe(
      "packet-auditor",
    );
  });

  it("resolves packet_auditor alias → packet-auditor", () => {
    expect(resolveProfileId(mapping, "packet_auditor")).toBe(
      "packet-auditor",
    );
  });

  it("resolves drift_checker → worker-drift_checker", () => {
    expect(resolveProfileId(mapping, "drift_checker")).toBe(
      "worker-drift_checker",
    );
  });

  it("resolves validator → spawned-validator", () => {
    expect(resolveProfileId(mapping, "validator")).toBe("spawned-validator");
  });

  it("throws for unknown role — no accidental fallback", () => {
    expect(() => resolveProfileId(mapping, "bogus-role")).toThrow(
      "No role binding found for worker role",
    );
  });

  it("throws for unknown role with descriptive message", () => {
    expect(() => resolveProfileId(mapping, "supervisor")).toThrow(
      'No role binding found for worker role "supervisor"',
    );
  });

  it("does not fall back to worker-{role} pattern", () => {
    // The v1 switch had a default: return `worker-${role}`.
    // The v2 mapping must NOT have this accidental fallback.
    expect(() => resolveProfileId(mapping, "any-new-role")).toThrow();
  });
});

// ── resolveRoleConfig ──────────────────────────────────────────

describe("resolveRoleConfig", () => {
  it("returns coder defaults from the validated default mapping", () => {
    const mapping = loadWorkerRoleMapping(makeValidMapping());
    const config = resolveRoleConfig(mapping, "coder");

    expect(config?.systemPromptSource).toBe("spawned-coder");
    expect(config?.mcpToolSet).toEqual(["filesystem", "terminal", "git", "den", "delegation"]);
    expect(config?.drainEssentialTools).toEqual([
      "context_status",
      "post_structured_completion",
      "request_checkpoint",
    ]);
  });

  it("returns reviewer defaults from the validated default mapping", () => {
    const mapping = loadWorkerRoleMapping(makeValidMapping());
    const config = resolveRoleConfig(mapping, "reviewer");

    expect(config?.systemPromptSource).toBe("spawned-reviewer");
    expect(config?.mcpToolSet).toEqual([
      "filesystem_readonly",
      "git_diff_log",
      "den",
    ]);
    expect(config?.drainEssentialTools).toEqual([
      "context_status",
      "post_structured_completion",
      "request_checkpoint",
    ]);
  });

  it("keeps request_checkpoint available in default supervised role drain tools", () => {
    const mapping = loadWorkerRoleMapping(makeValidMapping());
    for (const role of ["packet-auditor", "packet_auditor", "coder", "reviewer"]) {
      expect(resolveRoleConfig(mapping, role)?.drainEssentialTools).toContain(
        "request_checkpoint",
      );
    }
  });

  it("returns config when per-role config is present", () => {
    const mapping = loadWorkerRoleMapping(
      withBinding({
        role: "coder",
        profileId: "spawned-coder",
        config: {
          modelProvider: "openrouter",
          modelName: "anthropic/claude-sonnet-4",
          systemPromptSource: "spawned-coder",
          deterministicMode: false,
        },
      }),
    );
    const config = resolveRoleConfig(mapping, "coder");
    expect(config).toBeDefined();
    expect(config?.modelProvider).toBe("openrouter");
    expect(config?.modelName).toBe("anthropic/claude-sonnet-4");
    expect(config?.systemPromptSource).toBe("spawned-coder");
    expect(config?.deterministicMode).toBe(false);
  });

  it("returns undefined for known role without config", () => {
    const mapping = loadWorkerRoleMapping(
      withBinding({
        role: "coder",
        profileId: "spawned-coder",
        config: {
          mcpToolSet: ["file"],
        },
      }),
    );
    expect(resolveRoleConfig(mapping, "validator")).toBeUndefined();
  });

  it("returns undefined for unknown role (no binding at all)", () => {
    const mapping = loadWorkerRoleMapping(makeValidMapping());
    expect(resolveRoleConfig(mapping, "unknown-role")).toBeUndefined();
  });
});

// ── Concrete role example: PacketAuditor with full config ──────

describe("Concrete role: packet-auditor with full config", () => {
  it("round-trips full role config for packet-auditor", () => {
    const raw = withBinding({
      role: "packet-auditor",
      profileId: "packet-auditor",
      config: {
        modelProvider: "local",
        modelName: "packet-auditor-model",
        systemPromptSource: "packet-auditor",
        mcpToolSet: ["den-mcp", "audit-tools"],
        drainEssentialTools: ["post_worker_completion_packet"],
        deterministicMode: true,
        toolPolicyDefaults: {
          allowedTools: [
            "post_worker_completion_packet",
            "mcp_den_get_task",
            "mcp_den_get_messages",
          ],
          deniedTools: ["terminal", "write_file", "send_message"],
          allowedHosts: ["192.168.1.10"],
          deniedHosts: ["example.com"],
          workdirRoot: "/work/assignments",
          assignmentTimeoutMs: 900_000,
          idleTimeoutMs: 60_000,
          credentialScope: "den-mcp-only",
        },
      },
    });

    const mapping = loadWorkerRoleMapping(raw);
    const profileId = resolveProfileId(mapping, "packet-auditor");
    expect(profileId).toBe("packet-auditor");

    const config = resolveRoleConfig(mapping, "packet-auditor");
    expect(config).toBeDefined();
    expect(config?.systemPromptSource).toBe("packet-auditor");
    expect(config?.mcpToolSet).toEqual(["den-mcp", "audit-tools"]);
    expect(config?.drainEssentialTools).toEqual([
      "post_worker_completion_packet",
    ]);
    expect(config?.deterministicMode).toBe(true);
    expect(config?.toolPolicyDefaults?.allowedTools).toContain(
      "post_worker_completion_packet",
    );
    expect(config?.toolPolicyDefaults?.deniedTools).toContain("terminal");
    expect(config?.toolPolicyDefaults?.allowedHosts).toEqual(["192.168.1.10"]);
    expect(config?.toolPolicyDefaults?.workdirRoot).toBe("/work/assignments");
    expect(config?.toolPolicyDefaults?.assignmentTimeoutMs).toBe(900_000);
    expect(config?.toolPolicyDefaults?.credentialScope).toBe("den-mcp-only");
  });
});
