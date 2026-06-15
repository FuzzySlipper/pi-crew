export interface ModelStreamRetryPayload extends ModelStreamRetryCorrelationPayload {
  readonly sessionId: string;
  readonly profileId?: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryable: boolean;
  readonly reason: string;
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly delayMs?: number;
  readonly occurredAt: string;
}

export interface ModelStreamRetryCorrelationPayload {
  readonly assignmentId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly role?: string;
}
