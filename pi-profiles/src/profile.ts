/**
 * Profile types for the pi-crew agent system.
 *
 * Profiles define agent personality, skills, model configuration,
 * and tool access policy. They are global service-install configuration,
 * NOT per-user or per-frontend runtime state.
 *
 * @module pi-profiles/profile
 */

// ── Skill ───────────────────────────────────────────────────────

/**
 * A skill definition referenced by a profile.
 *
 * At load time the loader resolves skill references against the
 * filesystem. A missing skill reference causes a
 * {@link ConfigurationError} so runtime never sees unresolvable
 * promises.
 */
export interface Skill {
  /** Machine-readable skill identifier. */
  name: string;

  /** Human-readable one-liner. */
  description: string;

  /** Semver string for the skill definition. */
  version: string;

  /** Optional bounded skill instructions loaded from SKILL.md. */
  content?: string;

  /** Filesystem path for loaded SKILL.md content. */
  sourcePath?: string;

  /** Optional provenance classification for curator safety. */
  provenance?: "bundled" | "profile" | "agent" | "pinned";
}

// ── ModelConfig ─────────────────────────────────────────────────

/**
 * Per-profile model overrides.
 *
 * Every field is optional — omitted fields fall back to the
 * gateway-level default model configuration.
 */
export interface ModelConfig {
  /** Provider name (e.g. "openai", "anthropic"). */
  provider?: string;

  /** Model identifier (e.g. "gpt-4o", "claude-sonnet-4"). */
  model?: string;

  /** Optional OpenAI-compatible model endpoint URL. */
  baseUrl?: string;

  /** Optional API path/adapter selection for OpenAI-compatible routes. Defaults to chat completions. */
  api?: "openai-completions" | "openai-responses";

  /** Environment variable that supplies the provider API key. */
  apiKeyEnv?: string;

  /** Sampling temperature (0–2). */
  temperature?: number;

  /** Maximum output tokens for this profile. */
  maxTokens?: number;
}

// ── RuntimeConfig ────────────────────────────────────────────────

/** Per-profile execution budgets for runtime/delegated turns. */
export interface RuntimeConfig {
  /** Maximum model/tool loop turns for one delegated run. */
  maxIterations?: number;

  /** Maximum output tokens for a single model turn. */
  maxTokensPerTurn?: number;

  /** Maximum whole-run duration in milliseconds. */
  maxDurationMs?: number;

  /** Maximum duration for one turn in milliseconds. */
  maxTurnDurationMs?: number;

  /** Idle timeout in milliseconds. */
  idleTimeoutMs?: number;
}

// ── McpConfig ───────────────────────────────────────────────────

/** One selected MCP server for a profile MCP discovery surface. */
export interface McpServerSelection {
  /** Name of a crew-level `mcp.servers` entry. */
  name: string;

  /** Optional per-server Den MCP `tool_profile` query parameter. */
  toolProfile?: string;

  /** If true, connection failures are reported in diagnostics without failing the whole surface. */
  optional?: boolean;
}

/** Per-profile MCP discovery surface. */
export interface McpConfig {
  /** Optional full MCP endpoint override. Legacy single-server escape hatch. */
  endpoint?: string;

  /** Optional default Den MCP `tool_profile` query parameter. */
  toolProfile?: string;

  /** Named crew-level MCP servers selected for this profile. */
  servers?: McpServerSelection[];
}

// ── ToolPolicy ──────────────────────────────────────────────────

/**
 * Controls which tools/toolsets a profile is allowed to invoke.
 *
 * Three modes:
 * - `"allow_all"` — every tool is available (default).
 * - `"allow_list"` — only tools in {@link allow} are available.
 * - `"deny_list"` — everything except tools in {@link deny} is available.
 */
export interface ToolPolicy {
  /** Policy mode. Defaults to `"allow_all"` when absent. */
  mode?: "allow_all" | "allow_list" | "deny_list";

  /**
   * Tools or toolsets explicitly allowed.
   * Only meaningful when `mode` is `"allow_list"`.
   */
  allow?: string[];

  /**
   * Tools or toolsets explicitly denied.
   * Only meaningful when `mode` is `"deny_list"`.
   */
  deny?: string[];
}

// ── Profile ─────────────────────────────────────────────────────

/**
 * A fully-loaded agent profile.
 *
 * Profiles are the static personality/config layer. Runtime session
 * state (conversation history, blackboard, tool results) is layered
 * on top by the system-prompt assembler.
 */
export interface Profile {
  /**
   * Unique machine-readable profile identifier.
   * Matches the stem of the YAML file (e.g. `"system-architect"`).
   */
  id: string;

  /** Human-readable display name. */
  name: string;

  /** Short description of the profile's role and purpose. */
  description: string;

  /**
   * The base system prompt (personality + role definition).
   *
   * When the profile has an accompanying `.md` file, this is its
   * full content. When only a YAML file exists, this is the inline
   * `systemPrompt` field (which may be shorter).
   */
  systemPrompt: string;

  /** Skills this profile has access to. */
  skills: Skill[];

  /** Optional model overrides for this profile. */
  modelConfig?: ModelConfig;

  /** Optional execution budgets. */
  runtimeConfig?: RuntimeConfig;

  /** Optional MCP discovery surface for this profile. */
  mcpConfig?: McpConfig;

  /** Optional tool access policy. */
  toolPolicy?: ToolPolicy;

  /** Optional dense memory configuration. */
  memoryConfig?: MemoryConfig;

  /** Optional background review configuration for auto-triggered skill/memory nudge passes. */
  backgroundReview?: BackgroundReviewConfig;

  /** Human-readable display name. Falls back to `name` at agent config level. */
  displayName?: string;

  /** Default member identity for agents using this profile. */
  memberIdentity?: string;

  /** Default profile identity for agents using this profile. */
  profileIdentity?: string;

  /** Default member role for agents using this profile. */
  memberRole?: string;

  /** Default session-level configuration for agents using this profile. */
  sessionDefaults?: {
    ownerId?: string;
    maxHistoryMessages?: number;
    turnTimeoutMs?: number | null;
  };

  /** Default channel-level configuration for agents using this profile. */
  channelDefaults?: {
    wakePolicy?: "subscription" | "direct_polling";
  };
}

// ── BackgroundReviewConfig ───────────────────────────────────────

/** Configuration for per-profile background review settings. */
export interface BackgroundReviewConfig {
  /** Whether background review is enabled for this profile. Defaults to crew-level default. */
  enabled?: boolean;

  /** Turn interval for memory review nudges. Overrides crew-level defaultMemoryNudgeInterval. */
  memoryNudgeInterval?: number;

  /** Tool-iteration interval for skill review nudges. Overrides crew-level defaultSkillNudgeInterval. */
  skillNudgeInterval?: number;

  /** Maximum tokens per review subagent turn. Overrides crew-level defaultMaxTokens. */
  maxTokens?: number;

  /** Model configuration for review subagents. Falls back to crew defaults / profile modelConfig. */
  reviewModel?: ModelConfig;
}

// ── MemoryConfig ────────────────────────────────────────────────

/** Configuration for per-profile dense memory (Hermes MEMORY.md / USER.md compat). */
export interface MemoryConfig {
  /** Whether dense memory is enabled for this profile. Default: true. */
  enabled?: boolean;

  /** Optional custom tool description override. */
  toolDescription?: string;

  /** Byte caps for each target. */
  caps?: {
    /** Max bytes for the `memory` target. Default: 2200. */
    memory?: number;
    /** Max bytes for the `user` target. Default: 1375. */
    user?: number;
  };

  /** Storage backend preference. Default: hybrid. */
  storage?: "db" | "filesystem" | "hybrid";
}
