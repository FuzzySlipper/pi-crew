/** Checkpoint state controller for supervised worker Agents. */

import type { EventBus, Logger } from "@pi-crew/core";
import type { CheckpointRuntimeState, PostedCheckpoint } from "@pi-crew/tools";
import type { WorkerBinding } from "../sessions/types.js";
import type { AfterToolCallResult } from "./guarded-tool-types.js";

export type CheckpointPhase = "running" | "checkpoint_requested" | "checkpoint_waiting";

export interface WorkerCheckpointControllerConfig {
  readonly binding: WorkerBinding;
  readonly workerIdentity: string;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class WorkerCheckpointController implements CheckpointRuntimeState {
  readonly #binding: WorkerBinding;
  readonly #workerIdentity: string;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  #request: PostedCheckpoint | undefined;
  #phase: CheckpointPhase = "running";

  constructor(config: WorkerCheckpointControllerConfig) {
    this.#binding = config.binding;
    this.#workerIdentity = config.workerIdentity;
    this.#eventBus = config.eventBus;
    this.#logger = config.logger;
  }

  get isCheckpointRequested(): boolean {
    return this.#request !== undefined;
  }

  get currentRequest(): PostedCheckpoint | undefined {
    return this.#request;
  }

  get phase(): CheckpointPhase {
    return this.#phase;
  }

  markRequested(request: PostedCheckpoint): void {
    this.#request = request;
    this.#phase = "checkpoint_requested";
  }

  afterToolCall(): AfterToolCallResult | undefined {
    if (this.#request === undefined) return undefined;
    if (this.#phase !== "checkpoint_waiting") this.#emitWaiting();
    return { terminate: true };
  }

  clear(): void {
    if (this.#request === undefined && this.#phase === "running") return;
    this.#request = undefined;
    this.#phase = "running";
    this.#logger.info("WorkerCheckpointController: checkpoint cleared", {
      assignmentId: this.#binding.assignmentId,
      runId: this.#binding.runId,
    });
  }

  #emitWaiting(): void {
    const request = this.#request;
    if (request === undefined) return;
    this.#phase = "checkpoint_waiting";
    this.#eventBus.emit({
      event: "checkpoint.waiting",
      payload: {
        assignmentId: this.#binding.assignmentId,
        runId: this.#binding.runId,
        taskId: this.#binding.taskId,
        workerIdentity: this.#workerIdentity,
        checkpointId: request.checkpointId,
        reason: request.packet.reason,
        since: request.packet.since,
      },
    });
    this.#logger.info("WorkerCheckpointController: checkpoint waiting", {
      assignmentId: this.#binding.assignmentId,
      runId: this.#binding.runId,
      reason: request.packet.reason,
      checkpointId: request.checkpointId,
    });
  }
}
