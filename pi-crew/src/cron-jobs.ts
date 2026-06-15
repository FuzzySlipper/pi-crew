/** Config-defined cron job synchronization for pi-crew. */

import type { CronJobDraft, CronJobRecord, CronJobRepository } from "@pi-crew/service";
import type { CrewConfig } from "./config.js";

export type CrewCronJobConfig = CrewConfig["cron"]["jobs"][number];

export async function syncConfiguredCronJobs(
  repository: CronJobRepository,
  jobs: readonly CrewCronJobConfig[],
  now: Date,
): Promise<readonly CronJobRecord[]> {
  const synced: CronJobRecord[] = [];
  for (const job of jobs) synced.push(await repository.upsert(toDraft(job), now));
  return synced;
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
