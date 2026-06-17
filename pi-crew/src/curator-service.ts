/**
 * Curator service wrapper for pi-crew.
 *
 * Adapts the @pi-crew/service DefaultCuratorService (which requires a
 * `skillsRoot` parameter) to the pi-crew Crew's config shape by
 * deriving the skills root from the crew install layout.
 *
 * @module pi-crew/curator-service
 */

import { join } from "node:path";
import type { Logger } from "@pi-crew/core";
import {
  DefaultCuratorService as ServiceCuratorService,
  type CuratorConfig,
  type CuratorService,
  type CuratorRunResult,
  type CuratorStatus,
  type ArchivedSkill,
} from "@pi-crew/service";

export type { CuratorService, CuratorRunResult, CuratorStatus, ArchivedSkill };

/**
 * Wraps the pi-service DefaultCuratorService, deriving the skills root
 * from the crew install root when only the curator config and logger
 * are provided.
 *
 * The skills root is resolved as `{installRoot}/profiles/skills`.
 */
export class DefaultCuratorService implements CuratorService {
  readonly #inner: ServiceCuratorService;

  constructor(
    config: CuratorConfig & { installRoot: string },
    logger: Logger,
  ) {
    // Skills are stored under profiles/skills relative to the install root
    const skillsRoot = join(config.installRoot, "profiles", "skills");
    this.#inner = new ServiceCuratorService(skillsRoot, config, logger);
  }

  async runCuratorPass(now: Date): Promise<CuratorRunResult> {
    return this.#inner.runCuratorPass(now);
  }

  async runNow(dryRun: boolean): Promise<CuratorRunResult> {
    return this.#inner.runNow(dryRun);
  }

  async snapshot(): Promise<string> {
    return this.#inner.snapshot();
  }

  async rollback(snapshotPath: string): Promise<void> {
    return this.#inner.rollback(snapshotPath);
  }

  async listSnapshots(): Promise<string[]> {
    return this.#inner.listSnapshots();
  }

  async listArchived(): Promise<ArchivedSkill[]> {
    return this.#inner.listArchived();
  }

  async restore(skillName: string): Promise<void> {
    return this.#inner.restore(skillName);
  }

  async pin(skillName: string): Promise<void> {
    return this.#inner.pin(skillName);
  }

  async unpin(skillName: string): Promise<void> {
    return this.#inner.unpin(skillName);
  }

  async listPinned(): Promise<string[]> {
    return this.#inner.listPinned();
  }

  async status(): Promise<CuratorStatus> {
    return this.#inner.status();
  }

  async pause(): Promise<void> {
    return this.#inner.pause();
  }

  async resume(): Promise<void> {
    return this.#inner.resume();
  }
}
