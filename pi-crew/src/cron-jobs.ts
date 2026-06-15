/** Config-defined cron job synchronization for pi-crew. */

import type { CronJobDraft, CronJobRecord, CronJobRepository } from "@pi-crew/service";
import type { CrewConfig } from "./config.js";

export type CrewCronJobConfig = CrewConfig["cron"]["jobs"][number];

export interface CronJobSyncResult {
  readonly synced: readonly CronJobRecord[];
  readonly removed: readonly CronJobRecord[];
}

export async function syncConfiguredCronJobs(
  repository: CronJobRepository,
  jobs: readonly CrewCronJobConfig[],
  now: Date,
): Promise<CronJobSyncResult> {
  const configuredIds = new Set(jobs.map((job) => job.id));
  const removed: CronJobRecord[] = [];
  for (const existing of await repository.list()) {
    if (!configuredIds.has(existing.id)) {
      await repository.delete(existing.id);
      removed.push(existing);
    }
  }
  const synced: CronJobRecord[] = [];
  for (const job of jobs) synced.push(await repository.upsert(toDraft(job), now));
  return { synced, removed };
}

export function toDraft(job: CrewCronJobConfig): CronJobDraft {
  return {
    id: job.id,
    projectId: job.projectId,
    schedule: job.schedule,
    shape: job.shape,
    script: job.script,
    cwd: job.cwd,
    deliveryChannelId: job.deliveryChannelId,
    enabled: job.enabled,
    timezone: "UTC",
  };
}
