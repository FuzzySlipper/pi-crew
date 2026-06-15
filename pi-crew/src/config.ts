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
  DEFAULT_STREAM_RETRY_CONFIG,
} from "@pi-crew/service";

export const DEFAULT_INSTALL_ROOT = "/home/agents/pi-crew";
export const DEFAULT_INSTALL_CONFIG_PATH = join(DEFAULT_INSTALL_ROOT, "config.yaml");

// ── Crew-level config schema ───────────────────────────────────

const McpTransportSchema = z.enum(["stdio", "streamable-http"]);

const McpServerConfigSchema = z.object({
  transport: McpTransportSchema.default("streamable-http"),
  endpoint: z.string().url().optional(),
  requestTimeout: z.number().int().positive().default(30_000),
  maxReconnectAttempts: z.number().int().positive().default(3),
  reconnectBaseDelay: z.number().int().positive().default(1_000),
  optional: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.transport === "streamable-http" && value.endpoint === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "streamable-http MCP servers require endpoint", path: ["endpoint"] });
  }
  if (value.transport === "stdio") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stdio MCP servers are not supported yet", path: ["transport"] });
  }
});

const McpConfigSchema = z.object({
  transport: McpTransportSchema.default("streamable-http"),
  endpoint: z.string().url().default("http://192.168.1.10:5199/mcp"),
  requestTimeout: z.number().int().positive().default(30_000),
  maxReconnectAttempts: z.number().int().positive().default(3),
  reconnectBaseDelay: z.number().int().positive().default(1_000),
  defaultServer: z.string().min(1).default("den"),
  servers: z.record(z.string().min(1), McpServerConfigSchema).default({}),
}).transform((value) => {
  const servers = {
    [value.defaultServer]: {
      transport: value.transport,
      endpoint: value.endpoint,
      requestTimeout: value.requestTimeout,
      maxReconnectAttempts: value.maxReconnectAttempts,
      reconnectBaseDelay: value.reconnectBaseDelay,
      optional: false,
    },
    ...value.servers,
  };
  return { ...value, servers };
});

const SessionsConfigSchema = z.object({
  maxTotal: z.number().int().positive().default(16),
  maxPerProfile: z.number().int().positive().default(4),
  idleTimeoutMs: z.number().int().positive().default(28_800_000),
  fallbackProfileId: z.string().min(1).default("system-architect"),
});

const ContextConfigSchema = z.object({
  defaultContextLength: z.number().int().positive().default(131_072),
  compactionThresholdPercent: z.number().int().min(1).max(100).default(80),
  minimumRecentMessages: z.number().int().positive().default(24),
});

const StreamRetryConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_STREAM_RETRY_CONFIG.enabled),
  maxAttempts: z.number().int().min(1).max(10).default(DEFAULT_STREAM_RETRY_CONFIG.maxAttempts),
  baseDelayMs: z.number().int().nonnegative().default(DEFAULT_STREAM_RETRY_CONFIG.baseDelayMs),
  maxDelayMs: z.number().int().nonnegative().default(DEFAULT_STREAM_RETRY_CONFIG.maxDelayMs),
  jitterRatio: z.number().min(0).max(1).default(DEFAULT_STREAM_RETRY_CONFIG.jitterRatio),
  retryableHttpStatuses: z.array(z.number().int().min(100).max(599)).default([...DEFAULT_STREAM_RETRY_CONFIG.retryableHttpStatuses]),
}).default({}).superRefine((value, ctx) => {
  if (value.maxDelayMs < value.baseDelayMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "maxDelayMs must be greater than or equal to baseDelayMs", path: ["maxDelayMs"] });
  }
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

const FullAgentSessionConfigSchema = z.object({
  ownerId: z.string().min(1),
  sessionId: z.string().min(1),
  idleTimeoutMs: z.number().int().positive().optional(),
  maxHistoryMessages: z.number().int().positive(),
});

const FullAgentChannelConfigSchema = z.object({
  providerId: z.string().min(1),
  channelId: z.string().min(1),
  subscriptionIdentity: z.string().min(1),
  wakePolicy: z.enum(["subscription", "direct_polling"]).default("subscription"),
});

const ModelApiSchema = z.enum(["openai-completions", "openai-responses"]);

const FullAgentRuntimeConfigSchema = z
  .object({
    mode: z.literal("agent").default("agent"),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    api: ModelApiSchema.optional(),
    apiKeyEnv: z.string().min(1).optional(),
    systemPromptSource: z.literal("profile").default("profile"),
    tools: z.object({ allow: z.array(z.string().min(1)).default([]) }).default({}),
    toolPolicy: z.object({ mode: z.literal("profile") }).default({ mode: "profile" }),
  })
  .default({});

const FullAgentLifecycleConfigSchema = z.object({
  singleFlight: z.boolean().default(true),
  turnTimeoutMs: z.number().int().positive(),
  onStartup: z.literal("rehydrate_or_create").default("rehydrate_or_create"),
  onShutdownStatus: z.literal("offline").default("offline"),
});

const FullAgentConfigSchema = z.object({
  agentId: z.string().min(1),
  enabled: z.boolean().default(true),
  profileId: z.string().min(1),
  profileIdentity: z.string().min(1),
  memberIdentity: z.string().min(1),
  memberRole: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  session: FullAgentSessionConfigSchema,
  channels: z.array(FullAgentChannelConfigSchema).min(1),
  runtime: FullAgentRuntimeConfigSchema,
  lifecycle: FullAgentLifecycleConfigSchema,
});

const CronJobShapeSchema = z.enum(["script_only", "data_collection"]);

const CronJobConfigSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1).default("pi-crew"),
  schedule: z.string().min(1),
  shape: CronJobShapeSchema.default("script_only"),
  script: z.string().min(1),
  cwd: z.string().min(1).nullable().default(null),
  deliveryChannelId: z.string().min(1).nullable().default(null),
  enabled: z.boolean().default(true),
  timezone: z.literal("UTC").default("UTC"),
});

const CronConfigSchema = z.object({
  enabled: z.boolean().default(false),
  tickIntervalMs: z.number().int().positive().default(60_000),
  scriptRoot: z.string().min(1).default(DEFAULT_INSTALL_ROOT),
  staleRunAfterMs: z.number().int().positive().default(86_400_000),
  jobs: z.array(CronJobConfigSchema).default([]),
}).default({});

const DelegationProjectionConfigSchema = z.object({
  channelEnabled: z.boolean().default(false),
  localLogEnabled: z.boolean().default(true),
  localLogPath: z.string().min(1).optional(),
  projectToolCalledEvents: z.boolean().default(false),
});

const DelegationConfigSchema = z
  .object({
    llmBaseUrl: z.string().optional(),
    llmApiKey: z.string().optional(),
    llmModelName: z.string().optional(),
    projection: DelegationProjectionConfigSchema.default({}),
  })
  .default({});

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
  context: ContextConfigSchema.default({}),
  streamRetry: StreamRetryConfigSchema,
  toolPolicy: ToolPolicyDefaultsSchema.default({}),
  fullAgents: z.array(FullAgentConfigSchema).default([]),
  workerPool: WorkerPoolConfigSchema,
  workers: WorkerRoleMappingConfigSchema.default({
    bindings: DEFAULT_WORKER_ROLE_BINDINGS,
  }),
  cron: CronConfigSchema,
  delegation: DelegationConfigSchema,
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
  if (configIdx !== -1) {
    const cliPath = input.argv[configIdx + 1];
    if (cliPath === undefined || cliPath.length === 0 || cliPath.startsWith("--")) {
      throw new ConfigurationError("--config requires a path value");
    }
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
  rejectLegacyTerminologyConfig(parsed);

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

function rejectLegacyTerminologyConfig(parsed: unknown): void {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  if (Object.prototype.hasOwnProperty.call(parsed, "conversationalAgents")) {
    throw new ConfigurationError(
      "Legacy config key conversationalAgents is no longer supported; rename it to fullAgents.",
    );
  }
}

function absolutize(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
