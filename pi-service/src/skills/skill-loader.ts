/**
 * Filesystem skill loader for pi-crew.
 *
 * Scans configured directories for subdirectories containing `SKILL.md`
 * files, parses frontmatter, reads linked files (references/, templates/,
 * scripts/), and returns fully loaded {@link SkillRecord} objects.
 *
 * Directory layout expected:
 * ```
 * skillsDir/
 *   my-skill/
 *     SKILL.md
 *     references/   (optional)
 *     templates/    (optional)
 *     scripts/      (optional)
 *     assets/       (optional)
 * ```
 *
 * @module pi-service/skills/skill-loader
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@pi-crew/core";
import { parseSkillFrontmatter, type SkillRecord } from "@pi-crew/core";

// ── Config ─────────────────────────────────────────────────────

export interface SkillLoaderConfig {
  /** Directories to scan for skill subdirectories. */
  readonly skillsDirs: readonly string[];
  readonly logger: Logger;
}

// ── Constants ──────────────────────────────────────────────────

const SKILL_FILE = "SKILL.md";
const LINKED_DIRS = ["references", "templates", "scripts", "assets"] as const;

// ── Loader ─────────────────────────────────────────────────────

/**
 * Loads skills from the filesystem.
 *
 * Each entry in `skillsDirs` is scanned for subdirectories that contain
 * a `SKILL.md` file. Linked file directories are read recursively.
 */
export class FilesystemSkillLoader {
  private readonly skillsDirs: readonly string[];
  private readonly logger: Logger;

  constructor(config: SkillLoaderConfig) {
    this.skillsDirs = config.skillsDirs;
    this.logger = config.logger;
  }

  /**
   * Scan all configured directories and load every SKILL.md found.
   *
   * Silently skips directories that don't exist or contain no SKILL.md.
   */
  async loadAll(): Promise<readonly SkillRecord[]> {
    const results: SkillRecord[] = [];

    for (const dir of this.skillsDirs) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillDir = join(dir, entry.name);
          const record = await this.loadFromDirectory(skillDir);
          if (record !== null) {
            results.push(record);
          }
        }
      } catch (error: unknown) {
        if (isEnoent(error)) {
          this.logger.debug("Skill loader: directory does not exist, skipping", { dir });
        } else {
          this.logger.warn("Skill loader: error scanning directory", {
            dir,
            error: String(error),
          });
        }
      }
    }

    this.logger.info("Skill loader: loaded skills", { count: results.length });
    return results;
  }

  /**
   * Load a single skill from a directory.
   *
   * Returns `null` if the directory does not contain a `SKILL.md`,
   * or if parsing fails.
   */
  async loadFromDirectory(dirPath: string): Promise<SkillRecord | null> {
    const skillMdPath = join(dirPath, SKILL_FILE);

    let content: string;
    try {
      content = await readFile(skillMdPath, "utf-8");
    } catch (error: unknown) {
      if (isEnoent(error)) {
        return null;
      }
      this.logger.warn("Skill loader: error reading SKILL.md", {
        path: skillMdPath,
        error: String(error),
      });
      return null;
    }

    let frontmatter: SkillRecord["frontmatter"];
    let body: string;
    try {
      const parsed = parseSkillFrontmatter(content);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch (error: unknown) {
      this.logger.warn("Skill loader: error parsing SKILL.md", {
        path: skillMdPath,
        error: String(error),
      });
      return null;
    }

    const linkedFiles = await this.loadLinkedFiles(dirPath);

    const record: SkillRecord = {
      name: frontmatter.name,
      frontmatter,
      body,
      linkedFiles,
      source: "filesystem",
      sourcePath: dirPath,
      loadedAt: new Date().toISOString(),
    };

    this.logger.debug("Skill loader: loaded skill", {
      name: frontmatter.name,
      dir: dirPath,
      linkedFileCount: Object.keys(linkedFiles).length,
    });

    return record;
  }

  // ── Linked files ─────────────────────────────────────────────

  /**
   * Read all files from known linked directories (references/, templates/,
   * scripts/, assets/) relative to the skill directory.
   *
   * Returns a flat map of relative paths (e.g. `"references/api.md"`)
   * to file contents.
   */
  private async loadLinkedFiles(
    skillDir: string,
  ): Promise<Readonly<Record<string, string>>> {
    const files: Record<string, string> = {};

    for (const subdir of LINKED_DIRS) {
      const subdirPath = join(skillDir, subdir);
      try {
        const dirStat = await stat(subdirPath);
        if (!dirStat.isDirectory()) continue;
      } catch {
        continue;
      }

      await this.readDirRecursive(subdirPath, subdir, files);
    }

    return files;
  }

  /**
   * Recursively read all files under `absRoot`, prefixing paths with
   * `relativePrefix`.
   */
  private async readDirRecursive(
    absRoot: string,
    relativePrefix: string,
    accumulator: Record<string, string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(absRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name.toString();
      const entryPath = join(absRoot, name);
      const relativePath = `${relativePrefix}/${name}`;

      if (entry.isDirectory()) {
        await this.readDirRecursive(entryPath, relativePath, accumulator);
      } else if (entry.isFile()) {
        try {
          const content = await readFile(entryPath, "utf-8");
          accumulator[relativePath] = content;
        } catch (error: unknown) {
          this.logger.warn("Skill loader: error reading linked file", {
            path: entryPath,
            error: String(error),
          });
        }
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
