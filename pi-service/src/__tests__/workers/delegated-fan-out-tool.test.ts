/** Tests for delegated fan-out tool. */

import { describe, expect, it } from "vitest";
import { err, ok, type DelegatedResult, type EffectiveDelegationRuntime, type Result } from "@pi-crew/core";
import { createExecutionPolicy } from "@pi-crew/tools";
import { createDelegatedFanOutTool } from "../../workers/delegated-fan-out-tool.js";
import type { DelegatedSpawnError, DelegatedSpawnInput } from "../../workers/delegated-spawn-lifecycle.js";

const runtime: EffectiveDelegationRuntime = { profileId: "parent", provider: "local", model: "small" };
const policy = createExecutionPolicy({
  policyId: "parent-policy",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["fan_out_subagents", "spawn_subagent"],
  deniedTools: [],
  allowedHosts: [],
  deniedHosts: [],
  maxDurationMs: 10_000,
  maxTurnDurationMs: 1_000,
  idleTimeoutMs: 1_000,
  maxIterations: 2,
  maxTokensPerTurn: 1_000,
  credentialScope: "read_only",
});

describe("createDelegatedFanOutTool", () => {
  it("spawns all children subject to concurrency limits", async () => {
    const lifecycle = new ControlledLifecycle();
    const tool = createTool(lifecycle, 2);

    const result = await tool.execute("call-1", {
      tasks: ["a", "b", "c", "d"],
      maxConcurrency: 4,
    }, new AbortController().signal);

    expect(lifecycle.maxObservedConcurrency).toBe(2);
    expect(lifecycle.inputs).toHaveLength(4);
    const details = fanOutDetails(result.details);
    expect(details.results.map((item) => item.index)).toEqual([0, 1, 2, 3]);
    expect(details.results.every((item) => item.ok)).toBe(true);
  });

  it("returns mixed success and typed errors without erasing sibling results", async () => {
    const lifecycle = new ControlledLifecycle({ failIndexes: new Set([1]) });
    const tool = createTool(lifecycle, 3);

    const result = await tool.execute("call-1", { tasks: ["ok", "bad", "also ok"] }, new AbortController().signal);

    const details = fanOutDetails(result.details);
    expect(details.results).toHaveLength(3);
    expect(details.results[0]?.ok).toBe(true);
    expect(details.results[1]).toMatchObject({
      index: 1,
      task: "bad",
      ok: false,
      error: { code: "child_execution_failed", message: "child failed" },
    });
    expect(details.results[2]?.ok).toBe(true);
  });

  it("correlates per-child events with shared batch id and index", async () => {
    const lifecycle = new ControlledLifecycle();
    const tool = createTool(lifecycle, 2, "batch-fixed");

    await tool.execute("call-1", { tasks: ["a", "b"] }, new AbortController().signal);

    expect(lifecycle.inputs.map((input) => input.correlation?.batchId)).toEqual([
      "batch-fixed",
      "batch-fixed",
    ]);
    expect(lifecycle.inputs.map((input) => input.correlation?.batchIndex).sort()).toEqual(["0", "1"]);
  });

  it("bounds parent-visible child results and excludes raw transcripts", async () => {
    const lifecycle = new ControlledLifecycle({ longExcerpt: true });
    const tool = createTool(lifecycle, 1);

    const result = await tool.execute("call-1", { tasks: ["inspect"] }, new AbortController().signal);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const details = fanOutDetails(result.details);
    const child = details.results[0]?.result;

    expect(text.length).toBeLessThan(2_900);
    expect(text).not.toContain("RAW_TRANSCRIPT_SHOULD_NOT_APPEAR");
    expect(child?.safeExcerpt).not.toContain("RAW_TRANSCRIPT_SHOULD_NOT_APPEAR");
    expect(child?.artifacts).toEqual([
      { type: "den_message", messageId: 42, description: "child message" },
    ]);
  });
});

function createTool(lifecycle: ControlledLifecycle, maxConcurrentChildren: number, batchId = "batch-1") {
  return createDelegatedFanOutTool({
    lifecycle,
    parentSessionId: "parent-session",
    parentPolicy: policy,
    parentDelegationConstraints: { maxSpawnDepth: 1, maxConcurrentChildren },
    parentRuntime: runtime,
    batchId: () => batchId,
  });
}

class ControlledLifecycle {
  readonly inputs: DelegatedSpawnInput[] = [];
  maxObservedConcurrency = 0;
  #active = 0;
  readonly #failIndexes: Set<number>;
  readonly #longExcerpt: boolean;

  constructor(options: { readonly failIndexes?: Set<number>; readonly longExcerpt?: boolean } = {}) {
    this.#failIndexes = options.failIndexes ?? new Set();
    this.#longExcerpt = options.longExcerpt ?? false;
  }

  async spawn(input: DelegatedSpawnInput): Promise<Result<DelegatedResult, DelegatedSpawnError>> {
    this.inputs.push(input);
    this.#active += 1;
    this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.#active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.#active -= 1;
    const index = Number(input.correlation?.batchIndex ?? "0");
    if (this.#failIndexes.has(index)) {
      return err({ code: "child_execution_failed", message: "child failed" });
    }
    return ok({
      outcome: "success",
      summary: `completed ${input.task}`,
      policyId: `policy-${index}`,
      childSessionId: `child-${index}`,
      safeExcerpt: this.#longExcerpt
        ? `${"bounded ".repeat(250)}RAW_TRANSCRIPT_SHOULD_NOT_APPEAR`
        : undefined,
      artifacts: this.#longExcerpt
        ? [{ type: "den_message", messageId: 42, description: "child message" }]
        : undefined,
      evidenceChecked: false,
    });
  }
}

function fanOutDetails(details: unknown): {
  readonly batchId: string;
  readonly results: ReadonlyArray<{
    readonly index: number;
    readonly task: string;
    readonly ok: boolean;
    readonly result?: { readonly safeExcerpt?: string; readonly artifacts?: unknown };
    readonly error?: { readonly code: string; readonly message: string };
  }>;
} {
  if (!isRecord(details) || !isRecord(details["result"])) throw new Error("missing fan-out details");
  return details["result"] as never;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
