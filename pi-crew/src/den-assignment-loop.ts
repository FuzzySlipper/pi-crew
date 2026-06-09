import type { Logger } from "@pi-crew/core";
import type { DenAssignmentRunnerResult } from "./den-assignment-runner.js";

export interface DenAssignmentLoopRunner {
  runOnce(): Promise<DenAssignmentRunnerResult>;
}

export type DenAssignmentLoopTickResult =
  | { readonly status: "assignment_processed" }
  | { readonly status: "no_assignment" }
  | { readonly status: "busy" }
  | { readonly status: "drained" }
  | { readonly status: "stopped" };

export interface DenAssignmentLoopConfig {
  readonly workerIdentity: string;
  readonly runner: DenAssignmentLoopRunner;
  readonly pollIntervalMs: number;
  readonly logger: Logger;
  readonly delay?: (ms: number) => Promise<void>;
  readonly shouldAcceptWork?: () => boolean;
}

export interface DenAssignmentLoop {
  readonly workerIdentity: string;
  readonly isRunning: boolean;
  start(): void;
  stop(reason: string): Promise<void>;
  runTick(): Promise<DenAssignmentLoopTickResult>;
}

export function createDenAssignmentLoop(config: DenAssignmentLoopConfig): DenAssignmentLoop {
  return new PollingDenAssignmentLoop(config);
}

class PollingDenAssignmentLoop implements DenAssignmentLoop {
  readonly #config: DenAssignmentLoopConfig;
  readonly #delay: (ms: number) => Promise<void>;
  #running = false;
  #stopped = false;
  #busy = false;
  #loopTask: Promise<void> | null = null;

  constructor(config: DenAssignmentLoopConfig) {
    this.#config = config;
    this.#delay = config.delay ?? defaultDelay;
  }

  get workerIdentity(): string {
    return this.#config.workerIdentity;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#stopped = false;
    this.#running = true;
    this.#config.logger.info("assignment_loop.started", {
      workerIdentity: this.#config.workerIdentity,
    });
    this.#loopTask = this.#runLoop();
  }

  async stop(reason: string): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    this.#config.logger.info("assignment_loop.stopping", {
      workerIdentity: this.#config.workerIdentity,
      reason,
    });
    await this.#loopTask;
    this.#loopTask = null;
    this.#config.logger.info("assignment_loop.stopped", {
      workerIdentity: this.#config.workerIdentity,
      reason,
    });
  }

  async runTick(): Promise<DenAssignmentLoopTickResult> {
    if (this.#stopped) return { status: "stopped" };
    if (this.#busy) return { status: "busy" };
    if (this.#config.shouldAcceptWork?.() === false) {
      await this.#delay(this.#config.pollIntervalMs);
      return { status: "drained" };
    }

    this.#busy = true;
    try {
      const result = await this.#config.runner.runOnce();
      await this.#delay(this.#config.pollIntervalMs);
      if (result.status === "no_assignment") return { status: "no_assignment" };
      return { status: "assignment_processed" };
    } finally {
      this.#busy = false;
    }
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopped) {
      await this.runTick();
    }
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
