/**
 * Crew-level configuration schema and YAML loader.
 *
 * Kept outside the composition root so `crew.ts` stays focused on wiring
 * dependencies rather than parsing configuration.
 *
 * @module pi-crew/config
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";

import { ConfigurationError } from "@pi-crew/core";
import {
  GatewayConfigSchema,
  WorkerRoleMappingConfigSchema,
  DEFAULT_WORKER_ROLE_BINDINGS,
} from "@pi-crew/service";

export const DEFAULT_INSTALL_ROOT = "/home/agents/pi-crew";
export const DEFAULT_INSTALL_CONFIG_PATH = join(DEFAULT_INSTALL_ROOT, "config.yaml");

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

const InstallConfigSchema = z.object({
  root: z.string().min(1).default(DEFAULT_INSTALL_ROOT),
});

const ProfilesConfigSchema = z
  .object({
    root: z.string().min(1).optional(),
  })
  .default({});

const WorkerPoolMemberConfigSchema = z.object({
  workerIdentity: z.string().min(1),
  profileIdentity: z.string().min(1),
  role: z.string().min(1),
  displayName: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).default([]),
});

const WorkerPoolGroupConfigSchema = z.object({
  groupId: z.string().min(1),
  role: z.string().min(1),
  profileIdentity: z.string().min(1),
  profileId: z.string().min(1),
  desiredSize: z.number().int().nonnegative(),
  identityTemplate: z.string().min(1).includes("{n}"),
  displayNameTemplate: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).default([]),
  labels: z.record(z.string(), z.string()).default({}),
});

const WorkerPoolConfigSchema = z
  .object({
    members: z.array(WorkerPoolMemberConfigSchema).default([]),
    groups: z.array(WorkerPoolGroupConfigSchema).default([]),
  })
  .default({});

const ConversationalAgentSessionConfigSchema = z.object({
  ownerId: z.string().min(1),
  sessionId: z.string().min(1),
  idleTimeoutMs: z.number().int().positive().optional(),
  maxHistoryMessages: z.number().int().positive(),
});

const ConversationalAgentChannelConfigSchema = z.object({
  providerId: z.string().min(1),
  channelId: z.string().min(1),
  subscriptionIdentity: z.string().min(1),
  wakePolicy: z.enum(["subscription", "direct_polling"]).default("subscription"),
});

const ConversationalAgentRuntimeConfigSchema = z.object({
  mode: z.literal("agent"),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  systemPromptSource: z.literal("profile").default("profile"),
  tools: z.object({ allow: z.array(z.string().min(1)).default([]) }).default({}),
  toolPolicy: z.object({ mode: z.literal("profile") }),
});

const ConversationalAgentLifecycleConfigSchema = z.object({
  singleFlight: z.boolean().default(true),
  turnTimeoutMs: z.number().int().positive(),
  onStartup: z.literal("rehydrate_or_create").default("rehydrate_or_create"),
  onShutdownStatus: z.literal("offline").default("offline"),
});

const ConversationalAgentConfigSchema = z.object({
  agentId: z.string().min(1),
  enabled: z.boolean().default(true),
  profileId: z.string().min(1),
  profileIdentity: z.string().min(1),
  memberIdentity: z.string().min(1),
  memberRole: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  session: ConversationalAgentSessionConfigSchema,
  channels: z.array(ConversationalAgentChannelConfigSchema).min(1),
  runtime: ConversationalAgentRuntimeConfigSchema,
  lifecycle: ConversationalAgentLifecycleConfigSchema,
});

export const CrewConfigSchema = z.object({
  install: InstallConfigSchema.default({}),
  profiles: ProfilesConfigSchema,
  admin: GatewayConfigSchema.shape.admin,
  den: GatewayConfigSchema.shape.den,
  database: GatewayConfigSchema.shape.database.default({}),
  health: GatewayConfigSchema.shape.health.default({}),
  logging: GatewayConfigSchema.shape.logging.default({}),
  runtime: GatewayConfigSchema.shape.runtime,
  mcp: McpConfigSchema.default({}),
  sessions: SessionsConfigSchema.default({}),
  toolPolicy: ToolPolicyDefaultsSchema.default({}),
  conversationalAgents: z.array(ConversationalAgentConfigSchema).default([]),
  workerPool: WorkerPoolConfigSchema,
  workers: WorkerRoleMappingConfigSchema.default({
    bindings: DEFAULT_WORKER_ROLE_BINDINGS,
  }),
});

export type CrewConfig = z.infer<typeof CrewConfigSchema>;

export interface CrewInstallLayout {
  readonly root: string;
  readonly configPath: string;
  readonly profilesRoot: string;
}

export interface ResolveCrewConfigPathInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

export function resolveCrewConfigPath(input: ResolveCrewConfigPathInput): string {
  const envPath = input.env["PI_CREW_CONFIG"];
  if (envPath !== undefined && envPath.length > 0) {
    return absolutize(envPath, input.cwd);
  }

  const configIdx = input.argv.indexOf("--config");
  const cliPath = input.argv[configIdx + 1];
  if (configIdx !== -1 && cliPath !== undefined && cliPath.length > 0) {
    return absolutize(cliPath, input.cwd);
  }

  return DEFAULT_INSTALL_CONFIG_PATH;
}

export function resolveCrewInstallLayout(config: CrewConfig): CrewInstallLayout {
  const root = config.install.root;
  return {
    root,
    configPath: join(root, "config.yaml"),
    profilesRoot: config.profiles.root ?? join(root, "profiles"),
  };
}

/**
 * Load crew-level configuration from a YAML file path.
 *
 * Validates the shape and falls back to sensible defaults for every
 * field except `den.coreUrl`, which must be provided.
 */
export function loadCrewConfig(yamlPath: string): CrewConfig {
  const raw = readConfigFile(yamlPath);
  const parsed = parseConfigYaml(raw, yamlPath);

  const result = CrewConfigSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigurationError(`Invalid crew configuration:\n${issues}`);
  }

  validateConfiguredProfilesRoot(result.data.profiles.root);
  return result.data;
}

function readConfigFile(yamlPath: string): string {
  try {
    return readFileSync(yamlPath, "utf-8");
  } catch (error: unknown) {
    throw new ConfigurationError(
      `Cannot read crew configuration file at ${yamlPath}: ${errorMessage(error)}`,
    );
  }
}

function parseConfigYaml(raw: string, yamlPath: string): unknown {
  try {
    return parseYaml(raw);
  } catch {
    throw new ConfigurationError(
      `Malformed crew configuration file at ${yamlPath}: YAML syntax error (details redacted)`,
    );
  }
}

function validateConfiguredProfilesRoot(profilesRoot: string | undefined): void {
  if (profilesRoot === undefined) return;
  if (!existsSync(profilesRoot)) {
    throw new ConfigurationError(`Configured profiles root does not exist: ${profilesRoot}`);
  }
  if (!statSync(profilesRoot).isDirectory()) {
    throw new ConfigurationError(`Configured profiles root is not a directory: ${profilesRoot}`);
  }
}

function absolutize(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
