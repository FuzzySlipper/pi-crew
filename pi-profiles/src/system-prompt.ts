/**
 * System-prompt assembler — builds the full system prompt from a
 * loaded {@link Profile}, its skills, blackboard headings, and
 * runtime context.
 *
 * The assembler injects blackboard **headings only** (not full
 * content). Full blackboard retrieval is deferred to the memory
 * layer, which is not part of the initial pi-crew implementation.
 *
 * @module pi-profiles/system-prompt
 */

import type { Profile } from "./profile.js";

import {
  DEFAULT_MEMORY_CAP_BYTES,
  DEFAULT_USER_CAP_BYTES,
} from "@pi-crew/memory";

// ── Dense memory context ───────────────────────────────────────

/** Dense profile memory context for system prompt injection. */
export interface DenseMemoryContext {
  /** Full memory.md content for the current profile (or undefined if empty/disabled). */
  memoryContent?: string;
  /** Full user.md content for the current profile (or undefined if empty/disabled). */
  userContent?: string;
  /** Memory target cap in bytes. */
  memoryCapBytes?: number;
  /** User target cap in bytes. */
  userCapBytes?: number;
}

// ── Blackboard input ────────────────────────────────────────────

/**
 * Summary of the memory blackboard state.
 *
 * Only headings are included — the assembler never injects raw
 * blackboard content. The worker uses these headings to decide
 * whether to call the memory tool for full entries.
 */
export interface BlackboardHeadings {
  /** Ordered list of blackboard entry headings. */
  headings: string[];
}

// ── Runtime context ─────────────────────────────────────────────

/**
 * Transient runtime information layered onto the system prompt.
 *
 * This is assembled fresh for each worker session and is never
 * persisted in the profile definition.
 */
export interface RuntimeContext {
  /** Project identifier for this run. */
  projectId?: string;

  /** Task identifier for this run. */
  taskId?: string | number;

  /** Worker role (e.g. "coder", "reviewer"). */
  role?: string;

  /** Additional free-form context key-value pairs. */
  extra?: Record<string, string>;
}

// ── Assembly options ────────────────────────────────────────────

export interface PromptAssemblyOptions {
  /** The loaded agent profile. */
  profile: Profile;

  /** Optional blackboard headings for context. */
  blackboard?: BlackboardHeadings;

  /** Optional runtime context. */
  runtime?: RuntimeContext;

  /** Optional dense profile memory context for system prompt injection. */
  denseMemory?: DenseMemoryContext;
}

// ── Assembler ───────────────────────────────────────────────────

/**
 * Assemble a complete system prompt from a profile plus optional
 * blackboard headings and runtime context.
 *
 * The result is a single string suitable for passing as the
 * `system` message to an LLM provider.
 */
export function assembleSystemPrompt(options: PromptAssemblyOptions): string {
  const { profile, blackboard, runtime } = options;
  const sections: string[] = [];

  // ── 1. Profile personality ──────────────────────────────────
  sections.push(profile.systemPrompt.trim());

  // ── 2. Runtime context ──────────────────────────────────────
  if (runtime) {
    const ctxLines: string[] = [];
    if (runtime.role !== undefined) {
      ctxLines.push(`Current role: ${runtime.role}`);
    }
    if (runtime.projectId !== undefined) {
      ctxLines.push(`Project: ${runtime.projectId}`);
    }
    if (runtime.taskId !== undefined) {
      ctxLines.push(`Task: #${String(runtime.taskId)}`);
    }
    if (runtime.extra) {
      for (const [key, value] of Object.entries(runtime.extra)) {
        ctxLines.push(`${key}: ${value}`);
      }
    }
    if (ctxLines.length > 0) {
      sections.push(["## Runtime Context", ...ctxLines].join("\n"));
    }
  }

  // ── 3. Skills listing and bounded instructions ────────────────
  if (profile.skills.length > 0) {
    const skillLines = profile.skills.map(
      (s) => `- **${s.name}** (v${s.version}): ${s.description}`,
    );
    sections.push(["## Available Skills", ...skillLines].join("\n"));
    const loadedSkillSections = profile.skills
      .filter((skill) => skill.content !== undefined && skill.content.trim().length > 0)
      .map((skill) =>
        [
          `## Skill: ${skill.name}`,
          `Description: ${skill.description}`,
          skill.sourcePath === undefined ? undefined : `Source: ${skill.sourcePath}`,
          "",
          skill.content,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      );
    if (loadedSkillSections.length > 0) {
      sections.push(["## Loaded Skill Instructions", ...loadedSkillSections].join("\n\n"));
    }
  }

  // ── 4. Blackboard headings (headings only, not content) ─────
  if (blackboard && blackboard.headings.length > 0) {
    const headingLines = blackboard.headings.map((h) => `- ${h}`);
    sections.push(
      [
        "## Blackboard (headings only)",
        "Use memory tools to retrieve full entries.",
        ...headingLines,
      ].join("\n"),
    );
  }

  // ── 5. Tool policy (informational) ──────────────────────────
  if (profile.toolPolicy) {
    const tp = profile.toolPolicy;
    const policyLines: string[] = [];
    policyLines.push(`Mode: ${tp.mode ?? "allow_all"}`);
    if (tp.allow !== undefined && tp.allow.length > 0) {
      policyLines.push(`Allowed: ${tp.allow.join(", ")}`);
    }
    if (tp.deny !== undefined && tp.deny.length > 0) {
      policyLines.push(`Denied: ${tp.deny.join(", ")}`);
    }
    sections.push(["## Tool Policy", ...policyLines].join("\n"));
  }

  // ── 6. Dense profile memory context ──────────────────────────
  if (profile.memoryConfig === undefined || profile.memoryConfig.enabled !== false) {
    const block = denseMemoryContextBlock(options.denseMemory);
    if (block !== undefined) {
      sections.push(block);
    }
  }

  return sections.join("\n\n");
}

// ── Convenience ─────────────────────────────────────────────────

/**
 * Shortcut for assembling a system prompt when only the profile
 * is available (no blackboard, no runtime context).
 */
export function assembleProfilePrompt(profile: Profile): string {
  return assembleSystemPrompt({ profile });
}

// ── Dense memory context block ──────────────────────────────────

/**
 * Build the `<memory-context>` block for system prompt injection.
 *
 * Returns undefined when there is no content or context is undefined.
 * The block wraps content in `<memory-context>` tags with per-target
 * headers showing usage/cap, mirroring the style Hermes uses.
 */
export function denseMemoryContextBlock(context?: DenseMemoryContext): string | undefined {
  if (context === undefined) return undefined;

  const lines: string[] = [];

  const hasMemory =
    context.memoryContent !== undefined && context.memoryContent.trim().length > 0;
  const hasUser =
    context.userContent !== undefined && context.userContent.trim().length > 0;

  if (!hasMemory && !hasUser) return undefined;

  lines.push("<memory-context>");

  if (hasMemory) {
    const cap = context.memoryCapBytes ?? DEFAULT_MEMORY_CAP_BYTES;
    const used = context.memoryContent!.length;
    lines.push(`[MEMORY.md — used ${used} / ${cap} bytes]`);
    for (const entry of context.memoryContent!.split("\n")) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        lines.push(`• ${trimmed}`);
      }
    }
  }

  if (hasMemory && hasUser) {
    lines.push(""); // blank line between sections
  }

  if (hasUser) {
    const cap = context.userCapBytes ?? DEFAULT_USER_CAP_BYTES;
    const used = context.userContent!.length;
    lines.push(`[USER.md — used ${used} / ${cap} bytes]`);
    for (const entry of context.userContent!.split("\n")) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        lines.push(`• ${trimmed}`);
      }
    }
  }

  lines.push("</memory-context>");

  return lines.join("\n");
}
