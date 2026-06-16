/**
 * Degraded-mode health server — minimal HTTP listener that keeps the process
 * alive when crew configuration is invalid.
 *
 * Started BEFORE config loading so the process manager sees a listening port
 * and doesn't restart the process. Reports degraded status with diagnostic
 * details so operators can investigate and fix.
 *
 * Supports optional config file watching: when the config file is modified,
 * retries loading and self-destructs on success (handing off to the normal
 * Gateway).
 *
 * @module pi-crew/degraded-health-server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";

export interface ConfigErrorMessage {
  readonly field: string;
  readonly message: string;
}

export interface ConfigDegradedResult {
  readonly errors: readonly ConfigErrorMessage[];
  readonly configPath: string;
  readonly fileError?: string;
}

export interface DegradedHealthServerConfig {
  readonly host: string;
  readonly port: number;
}

/**
 * Minimal HTTP server that serves a degraded-status health endpoint.
 *
 * The health endpoint returns HTTP 200 with `{status: "degraded", reason: "..."}`
 * so process managers (systemd, s6, Docker) see the process as alive.
 */
export class DegradedHealthServer {
  readonly #config: DegradedHealthServerConfig;
  readonly #result: ConfigDegradedResult;
  readonly #onReload: ((newConfigYaml: string) => Promise<{ ok: boolean; error?: string }>) | null;
  #server: Server | null = null;
  #watcher: FSWatcher | null = null;
  #fileWatchResolve: (() => void) | null = null;

  constructor(
    config: DegradedHealthServerConfig,
    result: ConfigDegradedResult,
    onReload?: (newConfigYaml: string) => Promise<{ ok: boolean; error?: string }>,
  ) {
    this.#config = config;
    this.#result = result;
    this.#onReload = onReload ?? null;
  }

  /**
   * Start listening on the configured host:port.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.#handle(req, res);
      });

      server.once("error", (err: Error) => {
        reject(err);
      });

      server.listen(this.#config.port, this.#config.host, () => {
        this.#server = server;
        resolve();
      });
    });
  }

  /**
   * Stop the server and any active file watcher.
   */
  async stop(): Promise<void> {
    this.#stopWatcher();

    if (this.#server === null) return;

    const server = this.#server;
    this.#server = null;
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  /**
   * Start watching the config file for changes. When a change is detected,
   * calls the reload handler. If reload succeeds, resolves the returned
   * promise so the caller can proceed with normal startup.
   */
  watchConfigFile(configPath: string): Promise<void> {
    return new Promise((resolve) => {
      this.#fileWatchResolve = resolve;

      // Use a polling watch (watchFile) for reliability across editors
      const watcher = watch(configPath, async () => {
        const handler = this.#onReload;
        if (!handler) return;

        console.log(`Config file ${configPath} changed, retrying...`);
        try {
          const result = await handler(configPath);
          if (result.ok) {
            console.log("Config reloaded successfully after file change");
            resolve();
          } else {
            console.warn(`Config reload failed: ${result.error ?? "unknown error"}`);
          }
        } catch (err) {
          console.warn(`Config reload threw: ${(err as Error).message}`);
        }
      });

      this.#watcher = watcher;
    });
  }

  #stopWatcher(): void {
    if (this.#watcher !== null) {
      this.#watcher.close();
      this.#watcher = null;
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${this.#config.host}:${String(this.#config.port)}`);
    const pathname = url.pathname;

    // Health endpoint — returns 200 (not 503) so process manager stays happy
    if (pathname === "/" || pathname === "/health") {
      writeJson(res, 200, { status: "degraded", reason: "invalid_config", detail: this.#errorSummary() });
      return;
    }

    // Config error details
    if (pathname === "/admin/config-error") {
      writeJson(res, 200, {
        status: "degraded",
        errors: this.#result.errors.map((e) => `${e.field}: ${e.message}`),
        fileError: this.#result.fileError,
        configPath: this.#result.configPath,
      });
      return;
    }

    // Config reload endpoint
    if (method === "POST" && pathname === "/admin/control/config/reload") {
      if (!this.#onReload) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      try {
        const body = await readBody(req);
        const parsed: unknown = JSON.parse(body);
        const yaml = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["yaml"] : undefined;
        if (typeof yaml !== "string" || yaml.trim().length === 0) {
          writeJson(res, 400, { error: "yaml field required with new config YAML content" });
          return;
        }
        const result = await this.#onReload(yaml);
        if (result.ok) {
          writeJson(res, 200, { status: "reloaded" });
        } else {
          writeJson(res, 400, { status: "reload_failed", error: result.error });
        }
      } catch (err) {
        writeJson(res, 400, { status: "reload_failed", error: (err as Error).message });
      }
      return;
    }

    writeJson(res, 404, { error: "not_found" });
  }

  #errorSummary(): string {
    if (this.#result.fileError) return this.#result.fileError;
    if (this.#result.errors.length === 0) return "Unknown configuration error";
    return this.#result.errors[0]?.message ?? "Unknown configuration error";
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", reject);
  });
}
