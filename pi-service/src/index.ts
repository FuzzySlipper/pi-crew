// pi-service — Daemon runtime and orchestrator.
// Depends on: pi-core, pi-profiles, pi-mcp

import type { Logger } from "@pi-crew/core";

export interface GatewayConfig {
  port: number;
  host: string;
}

export class Gateway {
  private running = false;

  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await Promise.resolve();
    this.logger.info("Gateway starting", { config: this.config });
    this.running = true;
  }

  async stop(): Promise<void> {
    await Promise.resolve();
    this.logger.info("Gateway stopping");
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
