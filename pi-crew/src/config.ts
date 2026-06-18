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
import type { ConfigErrorMessage } from "./degraded-health-server.js";
import { ChannelProvidersConfigSchema } from "./channel-provider-factory.js";
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
  defaultMaxTokens: z.number().int().positive().default(4096),
  metadataLookupTimeoutMs: z.number().int().positive().default(5_000),
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

const MemoryPolicyModeSchema = z.enum([
  "off",
  "metadata_only",
  "manual",
  "suggested",
  "automatic_recall",
  "candidate_capture",
  "permissive_candidates",
]);

const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().optional(),
  requestTimeoutMs: z.number().int().positive().default(10_000),
  fullAgentPolicy: MemoryPolicyModeSchema.default("manual"),
  workerPolicy: MemoryPolicyModeSchema.default("metadata_only"),
}).default({}).superRefine((value, ctx) => {
  if (value.enabled && value.baseUrl === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enabled Den Memories config requires baseUrl", path: ["baseUrl"] });
  }
});

const AgentConfigSchema = z.object({
  identity: z.string().min(1).default("pi-crew"),
  projectId: z.string().min(1).default("pi-crew"),
}).default({});

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
    skillsRoot: z.string().min(1).optional(),
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
    denListPageSize: z.number().int().positive().default(200),
  })
  .default({});

const FullAgentSessionConfigSchema = z.object({
  ownerId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  maxHistoryMessages: z.number().int().positive().optional(),
});

const FullAgentChannelConfigSchema = z.object({
  providerId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  channelId: z.string().min(1),
  subscriptionIdentity: z.string().min(1).optional(),
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
    tools: z.object({ additionalAllow: z.array(z.string().min(1)).default([]) }).default({}),
    toolPolicy: z.object({ mode: z.literal("profile") }).default({ mode: "profile" }),
  })
  .default({});

const FullAgentLifecycleConfigSchema = z.object({
  singleFlight: z.boolean().default(true),
  turnTimeoutMs: z.number().int().positive().nullable(),
  onStartup: z.literal("rehydrate_or_create").default("rehydrate_or_create"),
  onShutdownStatus: z.literal("offline").default("offline"),
});

const FullAgentConfigSchema = z.object({
  agentId: z.string().min(1),
  enabled: z.boolean().default(true),
  profileId: z.string().min(1),
  profileIdentity: z.string().min(1).optional(),
  memberIdentity: z.string().min(1).optional(),
  memberRole: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  session: FullAgentSessionConfigSchema.optional(),
  channels: z.array(FullAgentChannelConfigSchema).min(1),
  runtime: FullAgentRuntimeConfigSchema,
  lifecycle: FullAgentLifecycleConfigSchema.optional(),
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
    maxSpawnDepth: z.number().int().positive().default(1),
    completionRetryMaxAttempts: z.number().int().positive().default(2),
    completionRetryBaseDelayMs: z.number().int().positive().default(1_000),
    completionRetryMaxDelayMs: z.number().int().positive().default(5_000),
  })
  .default({});

// ── Background review config ─────────────────────────────────────

const BackgroundReviewConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultMemoryNudgeInterval: z.number().int().positive().default(10),
  defaultSkillNudgeInterval: z.number().int().positive().default(10),
  maxConcurrentReviews: z.number().int().positive().default(3),
  serviceWorkChannel: z.string().min(1).default("7276"),
  serviceWorkUrl: z.string().url().optional(),
  defaultMaxTokens: z.number().int().positive().default(5000),
  triggerClaimTTLMs: z.number().int().positive().default(60_000),
  pollIntervalMs: z.number().int().positive().default(15_000),
  pollLimit: z.number().int().positive().default(20),
  startupDelayMs: z.number().int().nonnegative().default(2_000),
  mode: z.enum(["static", "llm"]).default("static"),
  static: z.object({
    maxEntryLength: z.number().int().positive().default(200),
    capacityAlertPercent: z.number().int().min(0).max(100).default(80),
    patternChecks: z.array(z.string()).default(["TBD", "TODO", "FIXME"]),
  }).default({}),
  llm: z.object({
    reviewModel: z.string().default("qwen-max"),
    maxTokens: z.number().int().positive().optional(),
    memoryPromptSlug: z.string().default("background-review-memory-prompt"),
    skillPromptSlug: z.string().default("background-review-skill-prompt"),
    denMcpUrl: z.string().default("http://192.168.1.10:5199/mcp"),
    denRouterUrl: z.string().url().optional(),
    requestTimeoutMs: z.number().int().positive().default(120_000),
    promptFetchTimeoutMs: z.number().int().positive().default(10_000),
    promptProjectId: z.string().min(1).default("pi-crew"),
  }).default({}),
}).default({}).superRefine((value, ctx) => {
  if (value.enabled && value.mode === "llm" && value.llm.denRouterUrl === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "backgroundReview.llm.denRouterUrl is required when mode is llm and enabled", path: ["llm", "denRouterUrl"] });
  }
});

export type BackgroundReviewConfig = z.infer<typeof BackgroundReviewConfigSchema>;

// ── Curator config ───────────────────────────────────────────────

const CuratorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  cronSchedule: z.string().default('0 0 */7 * *'),
  staleAfterDays: z.number().int().positive().default(30),
  archiveAfterDays: z.number().int().positive().default(90),
  snapshotRetentionDays: z.number().int().positive().default(30),
  minAgeDays: z.number().int().positive().default(1),
  dryRun: z.boolean().default(true),
  maxTokens: z.number().int().positive().default(5000),
  minTickMs: z.number().int().positive().default(60_000),
  auxiliaryModel: z.string().optional(),
  auxiliaryProvider: z.string().optional(),
}).default({});

export type CuratorConfig = z.infer<typeof CuratorConfigSchema>;

export const CrewConfigSchema = z.object({
  agent: AgentConfigSchema,
  install: InstallConfigSchema.default({}),
  profiles: ProfilesConfigSchema,
  admin: GatewayConfigSchema.shape.admin,
  den: GatewayConfigSchema.shape.den,
  database: GatewayConfigSchema.shape.database.default({}),
  health: GatewayConfigSchema.shape.health.default({}),
  healthCheckTimeoutMs: z.number().int().positive().default(3_000),
  assignmentLoopPollIntervalMs: z.number().int().positive().default(2_000),
  logging: GatewayConfigSchema.shape.logging.default({}),
  runtime: GatewayConfigSchema.shape.runtime,
  mcp: McpConfigSchema.default({}),
  sessions: SessionsConfigSchema.default({}),
  context: ContextConfigSchema.default({}),
  streamRetry: StreamRetryConfigSchema,
  memory: MemoryConfigSchema,
  toolPolicy: ToolPolicyDefaultsSchema.default({}),
  fullAgents: z.array(FullAgentConfigSchema).default([]),
  workerPool: WorkerPoolConfigSchema,
  workers: WorkerRoleMappingConfigSchema.default({
    bindings: DEFAULT_WORKER_ROLE_BINDINGS,
  }),
  cron: CronConfigSchema,
  delegation: DelegationConfigSchema,
  backgroundReview: BackgroundReviewConfigSchema,
  curator: CuratorConfigSchema.default({}),
  channelProviders: ChannelProvidersConfigSchema,
});

export type CrewConfig = z.infer<typeof CrewConfigSchema>;
export type FullAgentConfig = z.infer<typeof FullAgentConfigSchema>;

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

// ── Per-agent config isolation ──────────────────────────────────

/**
 * Validate each full agent config entry independently.
 *
 * Returns clean agents that passed validation separately from agents
 * that failed. This prevents one bad entry from blocking the entire
 * service from starting.
 */
export function validateFullAgentConfigIsolated(
  rawAgents: unknown[],
): { valid: FullAgentConfig[]; errors: ConfigErrorMessage[] } {
  const valid: FullAgentConfig[] = [];
  const errors: ConfigErrorMessage[] = [];

  for (let i = 0; i < rawAgents.length; i++) {
    const raw = rawAgents[i];
    const result = FullAgentConfigSchema.safeParse(raw);
    if (result.success) {
      valid.push(result.data);
    } else {
      const issues = result.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\\n");
      errors.push({
        field: `fullAgents[${i}]`,
        message: `Invalid agent config at index ${i}:\\n${issues}`,
      });
    }
  }

  return { valid, errors };
}

/**
 * Attempt to load config with per-agent error isolation.
 *
 * If the top-level schema fails on agent-specific fields, retries with
 * individual agent validation and logs the bad entries. Infrastructure
 * failures (missing den.coreUrl, bad YAML) still throw.
 *
 * Returns the validated config (with bad agents removed) and any
 * per-agent errors that were isolated.
 */
export function loadCrewConfigWithIsolation(
  yamlPath: string,
): { config: CrewConfig; skippedAgentErrors: ConfigErrorMessage[] } {
  const raw = readConfigFile(yamlPath);
  const parsed = parseConfigYaml(raw, yamlPath);
  rejectLegacyTerminologyConfig(parsed);

  // Try normal parse first
  const result = CrewConfigSchema.safeParse(parsed ?? {});
  if (result.success) {
    validateConfiguredProfilesRoot(result.data.profiles.root);
    return { config: result.data, skippedAgentErrors: [] };
  }

  // Check if failures are all agent-related — try isolation
  const issues = result.error.issues;
  const agentIssues = issues.filter((i) => i.path.length >= 1 && i.path[0] === "fullAgents");
  const otherIssues = issues.filter((i) => !(i.path.length >= 1 && i.path[0] === "fullAgents"));

  // If there are non-agent issues, the full validation still fails
  if (otherIssues.length > 0) {
    const formatted = issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\\n");
    throw new ConfigurationError(`Invalid crew configuration:\\n${formatted}`);
  }

  // All failures are agent-related — do per-agent isolation
  const rawParsed = parsed as Record<string, unknown>;
  const rawAgents = Array.isArray(rawParsed["fullAgents"]) ? (rawParsed["fullAgents"] as unknown[]) : [];

  const { valid, errors } = validateFullAgentConfigIsolated(rawAgents);

  // Build a cleaned-up raw object with only valid agents
  const cleanedRaw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawParsed)) {
    if (value !== undefined) cleanedRaw[key] = value;
  }
  cleanedRaw["fullAgents"] = valid;

  // Re-parse with cleaned agents
  const retryResult = CrewConfigSchema.safeParse(cleanedRaw);
  if (!retryResult.success) {
    // Something still fails — throw with combined errors
    const formatted = retryResult.error.issues
      .concat(errors.map((e) => ({
        code: z.ZodIssueCode.custom,
        message: e.message,
        path: [e.field],
      } as z.ZodIssue)))
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\\n");
    throw new ConfigurationError(`Invalid crew configuration (with isolated agents):\\n${formatted}`);
  }

  validateConfiguredProfilesRoot(retryResult.data.profiles.root);
  return { config: retryResult.data, skippedAgentErrors: errors };
}

/**
 * Degraded-mode config loader. Reads and parses YAML, returns either a
 * valid config or a structured degraded result. Never throws.
 */
export function tryLoadCrewConfigDegraded(
  yamlPath: string,
): { ok: true; config: CrewConfig; skippedAgentErrors: ConfigErrorMessage[] } | { ok: false; result: import("./degraded-health-server.js").ConfigDegradedResult } {
  try {
    const { config, skippedAgentErrors } = loadCrewConfigWithIsolation(yamlPath);
    return { ok: true as const, config, skippedAgentErrors };
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      return {
        ok: false as const,
        result: {
          errors: [{ field: "config", message: error.message }],
          configPath: yamlPath,
        },
      };
    }
    // File I/O errors, YAML parse errors
    return {
      ok: false as const,
      result: {
        errors: [{ field: "config", message: errorMessage(error) }],
        configPath: yamlPath,
        fileError: errorMessage(error),
      },
    };
  }
}
