/**
 * pi-crew service entrypoint — executable main for long-lived service process.
 *
 * Loads configuration from PI_CREW_CONFIG env var or --config CLI arg,
 * bootstraps the Crew composition root, starts the gateway (including the
 * health-check HTTP server), performs a local health smoke check, then
 * blocks on signals until graceful shutdown.
 *
 * Usage:
 *   PI_CREW_CONFIG=/path/to/config.yaml node dist/main.js
 *   node dist/main.js --config /path/to/config.yaml
 *
 * @module pi-crew/main
 */

import { resolve } from "node:path";
import { env, argv, exit, stdout } from "node:process";
import { bootstrap } from "./crew.js";

// ── Config path resolution ──────────────────────────────────────

/**
 * Resolve the YAML configuration file path.
 *
 * Priority:
 * 1. PI_CREW_CONFIG environment variable
 * 2. --config <path> CLI argument
 * 3. Default: ./config/default.yaml (relative to CWD)
 */
function resolveConfigPath(): string {
  const envPath = env["PI_CREW_CONFIG"];
  if (envPath !== undefined && envPath.length > 0) {
    return resolve(envPath);
  }

  const configIdx = argv.indexOf("--config");
  if (configIdx !== -1 && configIdx + 1 < argv.length) {
    const cliPath = argv[configIdx + 1];
    if (cliPath !== undefined && cliPath.length > 0) {
      return resolve(cliPath);
    }
  }

  return resolve("config/default.yaml");
}

// ── Health smoke ────────────────────────────────────────────────

interface HealthResponse {
  status: string;
  uptime?: number;
}

/**
 * Perform a local health-check smoke request against the gateway.
 *
 * Returns true if the endpoint responds with status "ok".
 * Logs warnings for non-200 responses but does not fail startup —
 * the gateway is running; this is just a smoke confirmation.
 */
async function healthSmoke(host: string, port: number): Promise<boolean> {
  const url = `http://${host}:${String(port)}/`;
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      console.warn(
        `Health smoke returned HTTP ${String(response.status)} from ${url}`,
      );
      return false;
    }
    const body = (await response.json()) as HealthResponse;
    console.log(
      `Health smoke OK: status=${body.status}, uptime=${String(body.uptime ?? "n/a")}s`,
    );
    return body.status === "ok";
  } catch (error: unknown) {
    console.warn(
      `Health smoke failed: ${url} — ${(error as Error).message}`,
    );
    return false;
  }
}

// ── Signal handling ─────────────────────────────────────────────

type ShutdownFn = () => Promise<void>;

/**
 * Install process-level signal handlers for graceful shutdown.
 *
 * Catches SIGINT (Ctrl+C) and SIGTERM (process manager stop).
 * Calls the provided `stop` function and exits cleanly.
 */
function installSignalHandlers(stop: ShutdownFn): void {
  let shuttingDown = false;

  const handler = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    stop()
      .then(() => {
        exit(0);
      })
      .catch((error: unknown) => {
        console.error("Shutdown error:", (error as Error).message);
        exit(1);
      });
  };

  process.on("SIGINT", () => {
    handler("SIGINT");
  });
  process.on("SIGTERM", () => {
    handler("SIGTERM");
  });
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configPath = resolveConfigPath();
  console.log(`pi-crew starting with config: ${configPath}`);

  const crew = bootstrap(configPath);

  installSignalHandlers(async () => {
    await crew.stop("signal");
  });

  await crew.start();

  console.log("pi-crew service started");

  // Local foreground health smoke
  const { host, port } = crew.gateway.healthConfig;
  const healthy = await healthSmoke(host, port);
  if (!healthy) {
    console.warn(
      "Health smoke did not confirm ok status — gateway may still be starting",
    );
  }

  stdout.write("pi-crew running (Ctrl+C to stop)\n");
}

main().catch((error: unknown) => {
  console.error("Fatal startup error:", (error as Error).message);
  exit(1);
});
