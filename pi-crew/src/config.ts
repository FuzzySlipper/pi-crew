/**
 * Crew-level configuration schema and YAML loader.
 *
 * Kept outside the composition root so `crew.ts` stays focused on wiring
 * dependencies rather than parsing configuration.
 *
 * @module pi-crew/config
 */

import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";

import { ConfigurationError } from "@pi-crew/core";
import {
  GatewayConfigSchema,
  WorkerRoleMappingConfigSchema,
  DEFAULT_WORKER_ROLE_BINDINGS,
} from "@pi-crew/service";

// ── Crew-level config schema ───────────────────────────────────

const McpConfigSchema = z.object({
  transport: z.enum(["stdio", "streamable-http"]).default("streamable-http"),
  endpoint: z.string().default("http://192.168.1.10:5199/mcp"),
  requestTimeout: z.number().int().positive().default(30_000),
  maxReconnectAttempts: z.number().int().positive().default(3),
  reconnectBaseDelay: z.number().int().positive().default(1_000),
});

const SessionsConfigSchema = z.object({
  maxTotal: z.number().int().positive().default(16),
  maxPerProfile: z.number().int().positive().default(4),
  idleTimeoutMs: z.number().int().positive().default(28_800_000),
  fallbackProfileId: z.string().min(1).default("system-architect"),
});

const ToolPolicyDefaultsSchema = z.object({
  allowedTools: z.array(z.string()).default([]),
  deniedTools: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  deniedHosts: z.array(z.string()).default([]),
});

export const CrewConfigSchema = z.object({
  den: GatewayConfigSchema.shape.den,
  database: GatewayConfigSchema.shape.database.default({}),
  health: GatewayConfigSchema.shape.health.default({}),
  logging: GatewayConfigSchema.shape.logging.default({}),
  runtime: GatewayConfigSchema.shape.runtime,
  mcp: McpConfigSchema.default({}),
  sessions: SessionsConfigSchema.default({}),
  toolPolicy: ToolPolicyDefaultsSchema.default({}),
  workers: WorkerRoleMappingConfigSchema.default({
    bindings: DEFAULT_WORKER_ROLE_BINDINGS,
  }),
});

export type CrewConfig = z.infer<typeof CrewConfigSchema>;

/**
 * Load crew-level configuration from a YAML file path.
 *
 * Validates the shape and falls back to sensible defaults for every
 * field except `den.coreUrl`, which must be provided.
 */
export function loadCrewConfig(yamlPath: string): CrewConfig {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed: unknown = parseYaml(raw);

  const result = CrewConfigSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigurationError(`Invalid crew configuration:\n${issues}`);
  }

  return result.data;
}
