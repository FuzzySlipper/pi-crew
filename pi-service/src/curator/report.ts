/** Report generation for curator runs. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@pi-crew/core";
import type { AutoTransition, CuratorMutation } from "./types.js";

export interface GenerateReportParams {
  runId: string;
  date: string;
  durationMs: number;
  autoTransitions: AutoTransition[];
  mutations: CuratorMutation[];
  errors: string[];
  skillsRoot: string;
  estimatedTokens: number;
}

function transitionsTable(transitions: AutoTransition[]): string {
  if (transitions.length === 0) {
    return "_No auto-transitions occurred._\n";
  }

  const rows = transitions.map(
    (t) => `| ${t.skillName} | ${t.type} | ${t.daysSinceLastUse} |`,
  );
  return [
    "| Skill | Type | Days Since Last Use |",
    "|-------|------|--------------------:|",
    ...rows,
    "",
  ].join("\n");
}

function mutationsTable(mutations: CuratorMutation[]): string {
  if (mutations.length === 0) {
    return "_No mutations were applied._\n";
  }

  const rows = mutations.map((m) => {
    const target = m.target ?? "—";
    const applied = m.applied ? "✅" : "❌";
    const error = m.error ?? "";
    return `| ${m.type} | ${m.skillName} | ${target} | ${applied} | ${error} |`;
  });
  return [
    "| Action | Skill | Target | Applied | Error |",
    "|--------|-------|--------|---------|-------|",
    ...rows,
    "",
  ].join("\n");
}

function errorsList(errors: string[]): string {
  if (errors.length === 0) {
    return "_No errors._\n";
  }
  return errors.map((e) => `- ${e}`).join("\n") + "\n";
}

function summaryLine(params: GenerateReportParams): string {
  const { autoTransitions, mutations, errors } = params;
  const parts: string[] = [];
  parts.push(`${autoTransitions.length} transition(s)`);
  parts.push(`${mutations.length} mutation(s)`);
  parts.push(`${errors.length} error(s)`);
  return parts.join(", ") + ".";
}

export function generateReport(
  params: GenerateReportParams,
  logger?: Logger,
): string {
  const { runId, date, durationMs, estimatedTokens } = params;

  const durationSec = (durationMs / 1000).toFixed(2);
  const report = [
    "# Curator Run Report",
    "",
    `**Run ID:** ${runId}`,
    `**Date:** ${date}`,
    `**Duration:** ${durationSec}s`,
    `**Estimated Tokens:** ${estimatedTokens}`,
    "",
    "---",
    "",
    "## Auto-Transitions",
    "",
    transitionsTable(params.autoTransitions),
    "",
    "## Mutations",
    "",
    mutationsTable(params.mutations),
    "",
    "## Errors",
    "",
    errorsList(params.errors),
    "",
    "---",
    "",
    "## Summary",
    "",
    summaryLine(params),
    "",
  ].join("\n");

  // Write to skillsRoot/logs/curator/{runId}/REPORT.md
  const logDir = join(params.skillsRoot, "logs", "curator", runId);
  const reportPath = join(logDir, "REPORT.md");
  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    writeFileSync(reportPath, report, "utf-8");
    logger?.debug("Curator report written", { reportPath });
  } catch (err) {
    logger?.warn("Failed to write curator report file", {
      reportPath,
      error: String(err),
    });
  }

  return report;
}
