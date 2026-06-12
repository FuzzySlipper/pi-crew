/**
 * In-memory skill registry for pi-crew.
 *
 * Stores loaded {@link SkillRecord} objects and supports lookup by name,
 * prefix, category, tag, and platform. Designed to be populated once at
 * profile startup and queried throughout the daemon lifecycle.
 *
 * @module pi-service/skills/skill-registry
 */

import type { Logger } from "@pi-crew/core";
import type { SkillRecord, SkillQuery } from "@pi-crew/core";

// ── Config ─────────────────────────────────────────────────────

export interface SkillRegistryConfig {
  readonly logger: Logger;
}

// ── Registry ───────────────────────────────────────────────────

/**
 * In-memory registry of loaded skills.
 *
 * Provides O(1) lookup by name, plus filtered listing via
 * {@link SkillQuery} parameters. Not thread-safe — callers must
 * serialize writes if used from async contexts.
 */
export class SkillRegistry {
  private readonly logger: Logger;
  private readonly skills: Map<string, SkillRecord> = new Map();

  constructor(config: SkillRegistryConfig) {
    this.logger = config.logger;
  }

  /** Register (or replace) a skill. */
  register(skill: SkillRecord): void {
    const existing = this.skills.get(skill.name);
    if (existing) {
      this.logger.debug("Skill registry: replacing existing skill", { name: skill.name });
    } else {
      this.logger.debug("Skill registry: registering skill", { name: skill.name });
    }
    this.skills.set(skill.name, skill);
  }

  /** Retrieve a skill by exact name. Returns `undefined` if not found. */
  get(name: string): SkillRecord | undefined {
    return this.skills.get(name);
  }

  /** Remove a skill by name. Returns `true` if it was present. */
  remove(name: string): boolean {
    const deleted = this.skills.delete(name);
    if (deleted) {
      this.logger.debug("Skill registry: removed skill", { name });
    }
    return deleted;
  }

  /**
   * List skills, optionally filtered by query criteria.
   *
   * All filters are AND-combined. A skill must match every provided
   * criterion to be included in the result.
   *
   * - `name`: prefix match (case-insensitive)
   * - `category`: exact match (case-insensitive)
   * - `tag`: skill must include this tag (case-insensitive)
   * - `platform`: skill must list this platform
   */
  list(query?: SkillQuery): readonly SkillRecord[] {
    if (!query || Object.keys(query).length === 0) {
      return [...this.skills.values()];
    }

    const results: SkillRecord[] = [];

    for (const skill of this.skills.values()) {
      if (query.name !== undefined) {
        if (!skill.name.toLowerCase().startsWith(query.name.toLowerCase())) {
          continue;
        }
      }

      if (query.category !== undefined) {
        if (
          skill.frontmatter.category === undefined ||
          skill.frontmatter.category.toLowerCase() !== query.category.toLowerCase()
        ) {
          continue;
        }
      }

      if (query.tag !== undefined) {
        if (
          skill.frontmatter.tags === undefined ||
          !skill.frontmatter.tags.some((t: string) => t.toLowerCase() === query.tag!.toLowerCase())
        ) {
          continue;
        }
      }

      if (query.platform !== undefined) {
        if (
          skill.frontmatter.platforms === undefined ||
          !skill.frontmatter.platforms.includes(
            query.platform as "linux" | "macos" | "windows",
          )
        ) {
          continue;
        }
      }

      results.push(skill);
    }

    return results;
  }

  /** Number of registered skills. */
  get size(): number {
    return this.skills.size;
  }
}
