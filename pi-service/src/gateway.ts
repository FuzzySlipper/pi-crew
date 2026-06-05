/**
 * Gateway lifecycle manager.
 *
 * The Gateway owns the HTTP health-check server, coordinates startup
 * and shutdown, and emits typed events on the shared {@link EventBus}
 * so other modules can react without importing from gateway.ts directly.
 *
 * Dependencies are constructor-injected — no singletons, no global
 * state, no module-level side effects.
 *
 * @module pi-service/gateway
 */

import { createServer, type Server } from "node:http";
import { ConnectionError, type Logger, type EventBus } from "@pi-crew/core";
import type { GatewayConfig, HealthConfig } from "./config.js";

/** Check that Den is reachable before the gateway accepts work. */
export type DenReachabilityCheck = (coreUrl: string) => Promise<void>;

/**
 * Default Den startup check.
 *
 * The Den unavailability ADR requires pi-service to refuse startup if
 * Den is unreachable. Any HTTP response proves the LAN route and Den
 * process are reachable; network errors or 5xx responses fail startup.
 */
export async function defaultDenReachabilityCheck(
  coreUrl: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 5_000);

  try {
    const response = await fetch(coreUrl, {
      method: "GET",
      signal: controller.signal,
    });

    if (response.status >= 500) {
      throw new ConnectionError(
        `Den startup check failed for ${coreUrl}: HTTP ${String(response.status)}`,
      );
    }
  } catch (error) {
    if (error instanceof ConnectionError) {
      throw error;
    }

    throw new ConnectionError(
      `Den startup check failed for ${coreUrl}: ${(error as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ── Gateway ─────────────────────────────────────────────────────

export class Gateway {
  private healthServer: Server | null = null;
  private running = false;
  private shutdownReason = "";

  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
    private readonly eventBus: EventBus,
    private readonly denReachabilityCheck: DenReachabilityCheck =
      defaultDenReachabilityCheck,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────

  /**
   * Start the gateway: validate config, start the health-check server.
   *
   * Idempotent — calling start on an already-running gateway is a no-op.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.debug("Gateway.start called but already running");
      return;
    }

    this.logger.info("Gateway starting", {
      healthPort: this.config.health.port,
      healthHost: this.config.health.host,
      logLevel: this.config.logging.level,
    });

    if (this.config.den.requiredAtStartup) {
      await this.denReachabilityCheck(this.config.den.coreUrl);
    }

    await this.startHealthServer();
    this.running = true;

    this.logger.info("Gateway started");
  }

  /**
   * Initiate graceful shutdown.
   *
   * 1. Stops the health-check server.
   * 2. Emits `gateway.shutdown` on the event bus.
   * 3. Transitions to stopped state.
   *
   * @param reason — Human-readable reason for shutdown.
   */
  async stop(reason: string): Promise<void> {
    if (!this.running) {
      this.logger.debug("Gateway.stop called but not running");
      return;
    }

    this.logger.info("Gateway stopping", { reason });
    this.shutdownReason = reason;

    await this.stopHealthServer();

    this.eventBus.emit({
      event: "gateway.shutdown",
      payload: { reason },
    });

    this.running = false;
    this.logger.info("Gateway stopped");
  }

  // ── Queries ────────────────────────────────────────────────

  /** Whether the gateway is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** The reason the gateway was last stopped (empty if still running). */
  get lastShutdownReason(): string {
    return this.shutdownReason;
  }

  /** The health-check server configuration. */
  get healthConfig(): HealthConfig {
    return this.config.health;
  }

  // ── Health server ──────────────────────────────────────────

  private startHealthServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((_req, res) => {
        if (!this.running) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "shutting_down" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            uptime: process.uptime(),
          }),
        );
      });

      server.once("error", (err) => {
        this.logger.error("Health server failed to start", {
          error: err.message,
        });
        reject(err);
      });

      server.listen(this.config.health.port, this.config.health.host, () => {
        this.healthServer = server;
        this.logger.info("Health server listening", {
          host: this.config.health.host,
          port: this.config.health.port,
        });
        resolve();
      });
    });
  }

  private stopHealthServer(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.healthServer) {
        resolve();
        return;
      }

      this.healthServer.close(() => {
        this.logger.info("Health server closed");
        this.healthServer = null;
        resolve();
      });
    });
  }
}
