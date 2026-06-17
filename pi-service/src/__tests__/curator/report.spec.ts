/** Tests for curator report generation. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateReport } from "../../curator/report.js";
import type { Logger } from "@pi-crew/core";
import type { GenerateReportParams } from "../../curator/types.js";

const MINIMAL_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeSkillsRoot(): string {
  return mkdtempSync(join(tmpdir(), "curator-report-test-"));
}

describe("generateReport", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const baseParams: GenerateReportParams = {
    runId: "curator-test-001",
    date: "2026-06-17T00:00:00.000Z",
    durationMs: 1500,
    autoTransitions: [],
    mutations: [],
    errors: [],
    skillsRoot: "/tmp/placeholder",
    estimatedTokens: 500,
  };

  it("generates a report with run metadata", () => {
    const report = generateReport(baseParams, MINIMAL_LOGGER);
    expect(report).toContain("# Curator Run Report");
    expect(report).toContain("curator-test-001");
    expect(report).toContain("2026-06-17");
    expect(report).toContain("1.50s");
    expect(report).toContain("500");
  });

  it("includes auto-transitions table when transitions exist", () => {
    const params: GenerateReportParams = {
      ...baseParams,
      autoTransitions: [
        { type: "stale", skillName: "old-skill", daysSinceLastUse: 45 },
        { type: "archived", skillName: "archive-me", daysSinceLastUse: 95 },
        { type: "reactivated", skillName: "revived", daysSinceLastUse: 15 },
      ],
    };
    const report = generateReport(params, MINIMAL_LOGGER);
    expect(report).toContain("| old-skill | stale | 45 |");
    expect(report).toContain("| archive-me | archived | 95 |");
    expect(report).toContain("| revived | reactivated | 15 |");
    expect(report).toContain("3 transition(s)");
  });

  it("shows 'no transitions' when none occurred", () => {
    const report = generateReport(baseParams, MINIMAL_LOGGER);
    expect(report).toContain("No auto-transitions occurred");
    expect(report).toContain("0 transition(s)");
  });

  it("includes mutations table when mutations exist", () => {
    const params: GenerateReportParams = {
      ...baseParams,
      mutations: [
        { type: "archive", skillName: "old-skill", dryRun: false, applied: true },
        { type: "consolidate", skillName: "dup-skill", target: "umbrella", dryRun: true, applied: false, error: "dry run" },
      ],
    };
    const report = generateReport(params, MINIMAL_LOGGER);
    expect(report).toContain("| archive | old-skill | — | ✅ |");
    expect(report).toContain("| consolidate | dup-skill | umbrella | ❌ |");
    expect(report).toContain("2 mutation(s)");
  });

  it("shows 'no mutations' when none applied", () => {
    const report = generateReport(baseParams, MINIMAL_LOGGER);
    expect(report).toContain("No mutations were applied");
    expect(report).toContain("0 mutation(s)");
  });

  it("includes errors list when errors exist", () => {
    const params: GenerateReportParams = {
      ...baseParams,
      errors: ["Snapshot failed: disk full", "Archive collision on skill-x"],
    };
    const report = generateReport(params, MINIMAL_LOGGER);
    expect(report).toContain("- Snapshot failed: disk full");
    expect(report).toContain("- Archive collision on skill-x");
    expect(report).toContain("2 error(s)");
  });

  it("shows 'no errors' when none occurred", () => {
    const report = generateReport(baseParams, MINIMAL_LOGGER);
    expect(report).toContain("No errors");
    expect(report).toContain("0 error(s)");
  });

  it("writes report to skillsRoot/logs/curator/{runId}/REPORT.md", () => {
    const params: GenerateReportParams = {
      ...baseParams,
      skillsRoot: root,
    };
    generateReport(params, MINIMAL_LOGGER);
    const reportPath = join(root, "logs", "curator", "curator-test-001", "REPORT.md");
    expect(existsSync(reportPath)).toBe(true);
    const content = readFileSync(reportPath, "utf-8");
    expect(content).toContain("# Curator Run Report");
  });

  it("combines summary correctly", () => {
    const params: GenerateReportParams = {
      ...baseParams,
      autoTransitions: [{ type: "stale", skillName: "s1", daysSinceLastUse: 30 }],
      mutations: [{ type: "pin", skillName: "s2", dryRun: true, applied: true }],
      errors: ["minor issue"],
    };
    const report = generateReport(params, MINIMAL_LOGGER);
    expect(report).toContain("1 transition(s)");
    expect(report).toContain("1 mutation(s)");
    expect(report).toContain("1 error(s)");
  });
});
