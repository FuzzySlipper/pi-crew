/**
 * Gateway configuration loading and validation using zod.
 *
 * The gateway MUST crash on invalid config — there is no degraded-start
 * path.  Every field is validated at startup; any failure produces a
 * descriptive ConfigurationError.
 *
 * @module pi-service/config
 */

import { z } from "zod";
import { ConfigurationError } from "@pi-crew/core";

// ── Zod schemas ─────────────────────────────────────────────────

const DatabaseConfigSchema = z.object({
  /** Absolute path to the SQLite runtime database. */
  path: z
    .string()
    .min(1, "database.path must not be empty")
    .default("/var/lib/pi-crew/runtime.db"),
  /** Enable WAL mode for read concurrency. */
  wal: z.boolean().default(true),
});

const DenConfigSchema = z.object({
  /** REST API base URL for Den Core (e.g. "http://den-srv:3030"). */
  coreUrl: z.string().url("den.coreUrl must be a valid URL"),
  /** Whether to refuse startup if Den is unreachable. */
  requiredAtStartup: z.boolean().default(true),
});

const HealthConfigSchema = z.object({
  /** Port the health-check HTTP server listens on. */
  port: z.number().int().min(1).max(65535).default(9236),
  /** Host/IP to bind the health server to. */
  host: z.string().min(1).default("127.0.0.1"),
});

const LoggingConfigSchema = z.object({
  /** Minimum log level: "debug" | "info" | "warn" | "error". */
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** If true, output JSON to stdout instead of human-readable. */
  json: z.boolean().default(false),
});

export const GatewayConfigSchema = z.object({
  database: DatabaseConfigSchema.default({}),
  den: DenConfigSchema,
  health: HealthConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
});

// ── Inferred types ──────────────────────────────────────────────

/** Full strongly-typed gateway configuration. */
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/** Database sub-config. */
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

/** Den connectivity sub-config. */
export type DenConfig = z.infer<typeof DenConfigSchema>;

/** Health-check sub-config. */
export type HealthConfig = z.infer<typeof HealthConfigSchema>;

/** Logging sub-config. */
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

// ── Loader ──────────────────────────────────────────────────────

/**
 * Parse and validate raw configuration data.
 *
 * Returns the validated config or throws {@link ConfigurationError}
 * with a multi-line message listing every validation failure.
 *
 * @param raw — Untrusted config object (e.g. from JSON or env).
 * @returns Parsed and validated {@link GatewayConfig}.
 */
export function loadConfig(raw: unknown): GatewayConfig {
  const result = GatewayConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigurationError(
      `Invalid gateway configuration:\n${issues}`,
    );
  }

  return result.data;
}
