/**
 * ToolOutputRouter — routes tool results to the correct verbosity
 * level for agent context while preserving full/redacted output
 * for the audit log.
 *
 * The agent's context window is precious real estate. This router
 * enforces per-tool verbosity defaults, ensuring the agent sees
 * only what it needs to reason about while the audit log captures
 * complete (redacted) data for debugging.
 *
 * @module pi-governance/output-router
 */

// ── Verbosity levels ──────────────────────────────────────────

/**
 * How much of a tool result enters agent context.
 *
 * | Level     | Token cost | What enters context               |
 * |-----------|------------|-----------------------------------|
 * | `ack`     | ~10-20     | Success/failure + ID              |
 * | `summary` | ~50-150    | One-line summary                  |
 * | `result`  | varies     | Meaningful output, stripped       |
 * | `verbose` | maximum    | Everything                        |
 */
export type VerbosityLevel = "ack" | "summary" | "result" | "verbose";

// ── Routed output ──────────────────────────────────────────────

/** The two-channel output produced by routing a tool result. */
export interface RoutedOutput<T = unknown> {
  /**
   * What the agent sees — trimmed to the effective verbosity.
   * This is injected into the agent's context window.
   */
  readonly agentContext: unknown;

  /**
   * Full tool result, suitable for audit logging after redaction.
   * This NEVER enters agent context.
   */
  readonly auditOutput: T;
}

// ── Per-tool defaults ─────────────────────────────────────────

/**
 * Per-tool verbosity defaults.
 *
 * These are the maximum verbosity each tool allows. Agents may
 * request a lower verbosity, but never higher.
 */
const TOOL_VERBOSITY_DEFAULTS: Record<string, VerbosityLevel> = {
  write_file: "summary",
  patch: "summary",
  terminal: "result",
  terminal_bg: "ack",
  read_file: "result",
  search_files: "result",
  web_search: "result",
  delegate_task: "summary",
  blackboard_lookup: "result",
  blackboard_summary: "result",
  browser_snapshot: "summary",
  browser_console: "summary",
};

/** Ordered verbosity (numeric rank for comparison). */
const VERBOSITY_RANK: Record<VerbosityLevel, number> = {
  ack: 0,
  summary: 1,
  result: 2,
  verbose: 3,
};

// ── ToolOutputRouter ──────────────────────────────────────────

/**
 * Routes tool results to agent-context and audit-log channels.
 *
 * @example
 * ```ts
 * const router = new ToolOutputRouter();
 * const { agentContext, auditOutput } = router.route("terminal", {
 *   stdout: "Build succeeded",
 *   exitCode: 0,
 * });
 * // agentContext → summary or result, depending on defaults
 * // auditOutput  → full result for the audit log
 * ```
 */
export class ToolOutputRouter {
  private readonly defaults: Record<string, VerbosityLevel>;

  /**
   * @param customDefaults Optional per-tool overrides merged on
   *   top of the built-in defaults.
   */
  constructor(customDefaults?: Record<string, VerbosityLevel>) {
    this.defaults = { ...TOOL_VERBOSITY_DEFAULTS, ...customDefaults };
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Resolve the effective verbosity for a tool call.
   *
   * The result is the **lower** of:
   * 1. The tool's configured maximum (default).
   * 2. The agent's requested level (if provided).
   *
   * Unknown tools default to `"result"`.
   */
  resolveVerbosity(
    toolName: string,
    requestedLevel?: VerbosityLevel,
  ): VerbosityLevel {
    const max = this.defaults[toolName] ?? "result";

    if (requestedLevel === undefined) return max;

    return VERBOSITY_RANK[requestedLevel] <= VERBOSITY_RANK[max]
      ? requestedLevel
      : max;
  }

  /**
   * Route a tool result into separate agent-context and audit
   * channels.
   *
   * The audit output is the full result unchanged. The agent
   * context is trimmed to the effective verbosity level.
   */
  route<T>(
    toolName: string,
    result: T,
    options?: RouteOptions,
  ): RoutedOutput<T> {
    const verbosity = this.resolveVerbosity(
      toolName,
      options?.requestedVerbosity,
    );

    return {
      agentContext: this.trimToVerbosity(result, verbosity),
      auditOutput: result,
    };
  }

  // ── Verbosity trimming ──────────────────────────────────────

  /**
   * Trim a tool result to the requested verbosity level.
   *
   * The trimming strategy depends on the result type:
   * - Objects with `success`/`exitCode`/`ok` fields get format
   *   treatment.
   * - Strings are truncated.
   * - Everything else passes through.
   */
  private trimToVerbosity(
    result: unknown,
    level: VerbosityLevel,
  ): unknown {
    if (level === "verbose") return result;

    if (result === null || result === undefined) return result;

    if (typeof result === "object") {
      const obj = result as Record<string, unknown>;

      // structured terminal-like result
      if ("exitCode" in obj || "ok" in obj || "success" in obj) {
        return this.trimStructured(obj, level);
      }

      // generic object: pass through at result/verbose, summary otherwise
      if (level === "ack" || level === "summary") {
        const keys = Object.keys(obj).slice(0, 3).join(", ");
        return `{ ${keys}${Object.keys(obj).length > 3 ? ", ..." : ""} }`;
      }

      return result;
    }

    if (typeof result === "string") {
      return this.trimString(result, level);
    }

    return result;
  }

  /**
   * Trim a structured (object) result.
   */
  private trimStructured(
    obj: Record<string, unknown>,
    level: VerbosityLevel,
  ): unknown {
    if (level === "ack") {
      const success = obj.success ?? obj.ok;
      const exitCode = obj.exitCode;
      if (success === false || (typeof exitCode === "number" && exitCode !== 0)) {
        return "✗ failed";
      }
      return "✓ success";
    }

    if (level === "summary") {
      const parts: string[] = [];
      if (obj.success !== undefined) {
        parts.push(obj.success ? "✓" : "✗");
      } else if (obj.ok !== undefined) {
        parts.push(obj.ok ? "✓" : "✗");
      }
      const ec = obj.exitCode;
      if (typeof ec === "number" || typeof ec === "string") {
        parts.push(`exit ${String(ec)}`);
      }
      if (obj.toolName !== undefined) {
        parts.push(obj.toolName as string);
      }
      return parts.join(" ") || JSON.stringify(obj).slice(0, 200);
    }

    return obj;
  }

  /**
   * Trim a string result.
   */
  private trimString(result: string, level: VerbosityLevel): string {
    if (level === "ack") {
      return "✓ done";
    }

    if (level === "summary") {
      return result.length <= 200 ? result : `${result.slice(0, 197)}...`;
    }

    return result;
  }
}

// ── Options ────────────────────────────────────────────────────

export interface RouteOptions {
  /**
   * The verbosity level requested by the agent. Will be capped
   * at the tool's configured maximum.
   */
  requestedVerbosity?: VerbosityLevel;
}
