/** Typed cron scheduler records and execution contracts. */

export type CronJobShape = "script_only" | "data_collection";
export type CronRunStatus = "running" | "succeeded" | "failed" | "skipped";

export interface CronJobRecord {
  readonly id: string;
  readonly projectId: string;
  readonly schedule: string;
  readonly shape: CronJobShape;
  readonly script: string;
  readonly cwd: string | null;
  readonly deliveryChannelId: string | null;
  readonly enabled: boolean;
  readonly timezone: "UTC";
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CronJobDraft {
  readonly id: string;
  readonly projectId: string;
  readonly schedule: string;
  readonly shape: CronJobShape;
  readonly script: string;
  readonly cwd?: string | null;
  readonly deliveryChannelId?: string | null;
  readonly enabled?: boolean;
  readonly timezone?: "UTC";
}

export interface CronRunRecord {
  readonly id: string;
  readonly jobId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: CronRunStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly errorMessage: string | null;
}

export interface CronRunCompletion {
  readonly finishedAt: string;
  readonly status: Exclude<CronRunStatus, "running">;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly errorMessage: string | null;
}

export interface CronJobRepository {
  upsert(job: CronJobDraft, now: Date): Promise<CronJobRecord>;
  get(jobId: string): Promise<CronJobRecord | null>;
  list(projectId?: string): Promise<readonly CronJobRecord[]>;
  due(now: Date): Promise<readonly CronJobRecord[]>;
  delete(jobId: string): Promise<boolean>;
  startRun(job: CronJobRecord, runId: string, startedAt: Date): Promise<CronRunRecord>;
  completeRun(runId: string, completion: CronRunCompletion): Promise<CronRunRecord>;
  reschedule(jobId: string, lastRunAt: Date, nextRunAt: Date | null): Promise<void>;
  recentRuns(jobId: string, limit: number): Promise<readonly CronRunRecord[]>;
  markStaleRunning(cutoff: Date, now: Date): Promise<readonly CronRunRecord[]>;
}

export interface CronJobExecutionResult {
  readonly status: Exclude<CronRunStatus, "running">;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly errorMessage: string | null;
}

export interface CronJobExecutor {
  execute(job: CronJobRecord, run: CronRunRecord): Promise<CronJobExecutionResult>;
}
