/** Tests for prime/assistant delegated helper tools. */

import { describe, expect, it } from "vitest";
import {
  ok,
  type DelegatedResult,
  type EffectiveDelegationRuntime,
  type Result,
} from "@pi-crew/core";
import { createExecutionPolicy } from "@pi-crew/tools";
import {
  createDelegationHelperTools,
  type DelegatedHelperToolResult,
} from "../../workers/delegated-helper-tools.js";
import type {
  DelegatedSpawnError,
  DelegatedSpawnInput,
} from "../../workers/delegated-spawn-lifecycle.js";

const runtime: EffectiveDelegationRuntime = {
  profileId: "prime-coder",
  provider: "den-router",
  model: "grok",
};
const policy = createExecutionPolicy({
  policyId: "prime-policy",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: [
    "scout_codebase",
    "summarize_files",
    "find_relevant_paths",
    "search_files",
    "read_file",
  ],
  deniedTools: [],
  allowedHosts: [],
  deniedHosts: [],
  maxDurationMs: 10_000,
  maxTurnDurationMs: 1_000,
  idleTimeoutMs: 1_000,
  maxIterations: 4,
  maxTokensPerTurn: 1_000,
  credentialScope: "read_only",
});

describe("createDelegationHelperTools", () => {
  it("creates concrete helper tool schemas for prime context-frugality", () => {
    const tools = createDelegationHelperTools(baseOptions(new HelperLifecycle()));

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "find_relevant_paths",
      "scout_codebase",
      "summarize_files",
    ]);
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("spawns a scout helper and returns compact path/range evidence", async () => {
    const lifecycle = new HelperLifecycle({
      safeExcerpt: JSON.stringify({
        summary: "Profile surfaces live in pi-profiles and config.",
        paths: [
          {
            path: "pi-profiles/profiles/prime-coder/soul.md",
            ranges: ["L1-L40"],
            why: "prime policy",
          },
        ],
        risks: ["config can drift from installed copy"],
        recommendedNextReads: ["pi-crew/config/default.yaml:L145-L185"],
      }),
    });
    const scout = toolByName("scout_codebase", lifecycle);

    const result = await scout.execute("call-1", {
      objective: "Find prime-coder surfaces",
      maxFiles: 5,
      includeTests: true,
    });

    expect(lifecycle.inputs).toHaveLength(1);
    expect(lifecycle.inputs[0]?.spawnRequest.expectedResultSchema).toBeUndefined();
    expect(lifecycle.inputs[0]?.task).toContain("scout_codebase");
    const details = helperDetails(result.details);
    expect(details.childSessionId).toBe("helper-1");
    expect(details.status).toBe("ok");
    expect(details.paths[0]).toMatchObject({
      path: "pi-profiles/profiles/prime-coder/soul.md",
      ranges: ["L1-L40"],
    });
    expect(details.toolsUsed).toEqual(["search_files", "read_file"]);
    expect(JSON.stringify(result)).not.toContain("RAW_TRANSCRIPT_SHOULD_NOT_APPEAR");
  });

  it("normalizes degraded helper reports instead of fail-closing on minor schema drift", async () => {
    const lifecycle = new HelperLifecycle({
      safeExcerpt: JSON.stringify({
        answer: "Found likely helper code.",
        candidatePaths: [
          { file: "pi-service/src/workers/delegated-spawn-tool.ts", lineRange: "L88-L129" },
        ],
        next: "Read delegated-spawn-tool constructor.",
      }),
    });
    const paths = toolByName("find_relevant_paths", lifecycle);

    const result = await paths.execute("call-1", { objective: "Find delegation helper surfaces" });

    const details = helperDetails(result.details);
    expect(details.status).toBe("degraded");
    expect(details.summary).toBe("Found likely helper code.");
    expect(details.paths).toEqual([
      { path: "pi-service/src/workers/delegated-spawn-tool.ts", ranges: ["L88-L129"] },
    ]);
    expect(details.warnings).toContain("normalized helper report aliases");
  });

  it("bounds large helper text and raw transcript sentinels", async () => {
    const lifecycle = new HelperLifecycle({
      safeExcerpt: `${"very long context ".repeat(260)}RAW_TRANSCRIPT_SHOULD_NOT_APPEAR`,
    });
    const summarize = toolByName("summarize_files", lifecycle);

    const result = await summarize.execute("call-1", {
      files: [{ path: "pi-service/src/workers/delegated-spawn-tool.ts", ranges: ["L1-L80"] }],
      question: "summarize",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const details = helperDetails(result.details);
    expect(text.length).toBeLessThan(2_800);
    expect(text).not.toContain("RAW_TRANSCRIPT_SHOULD_NOT_APPEAR");
    expect(details.safeExcerpt).not.toContain("RAW_TRANSCRIPT_SHOULD_NOT_APPEAR");
    expect(details.warnings).toContain("helper output was truncated");
  });

  it("returns partial failure details when the helper child times out", async () => {
    const lifecycle = new HelperLifecycle({ outcome: "timeout", summary: "budget elapsed" });
    const scout = toolByName("scout_codebase", lifecycle);

    const result = await scout.execute("call-1", { objective: "Find files" });

    const details = helperDetails(result.details);
    expect(details.status).toBe("partial");
    expect(details.outcome).toBe("timeout");
    expect(details.summary).toBe("budget elapsed");
  });
});

function baseOptions(lifecycle: HelperLifecycle) {
  return {
    lifecycle,
    parentSessionId: "prime-session",
    parentPolicy: policy,
    parentDelegationConstraints: { maxSpawnDepth: 1, maxConcurrentChildren: 2 },
    parentRuntime: runtime,
  };
}

function toolByName(name: string, lifecycle: HelperLifecycle) {
  const tool = createDelegationHelperTools(baseOptions(lifecycle)).find(
    (candidate) => candidate.name === name,
  );
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

class HelperLifecycle {
  readonly inputs: DelegatedSpawnInput[] = [];
  readonly #safeExcerpt: string | undefined;
  readonly #outcome: DelegatedResult["outcome"];
  readonly #summary: string;

  constructor(
    options: {
      readonly safeExcerpt?: string;
      readonly outcome?: DelegatedResult["outcome"];
      readonly summary?: string;
    } = {},
  ) {
    this.#safeExcerpt = options.safeExcerpt;
    this.#outcome = options.outcome ?? "success";
    this.#summary = options.summary ?? "helper completed";
  }

  async spawn(input: DelegatedSpawnInput): Promise<Result<DelegatedResult, DelegatedSpawnError>> {
    this.inputs.push(input);
    return ok({
      outcome: this.#outcome,
      summary: this.#summary,
      policyId: "helper-policy",
      childSessionId: "helper-1",
      safeExcerpt: this.#safeExcerpt,
      toolsUsed: ["search_files", "read_file"],
      evidenceChecked: false,
      artifacts: [{ type: "inventory_note", description: "helper report" }],
    });
  }
}

function helperDetails(details: unknown): DelegatedHelperToolResult {
  if (!isRecord(details) || !isRecord(details["result"])) throw new Error("missing helper result");
  return details["result"] as DelegatedHelperToolResult;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
