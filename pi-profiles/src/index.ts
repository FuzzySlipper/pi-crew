// pi-profiles — Agent personality, skill definitions, and system prompt assembly.
// Depends on: pi-core, js-yaml
//
// Profiles are global service-install configuration, NOT per-user or
// per-frontend runtime state. See planning-clarifications-v1 §1, §4.

// ── Types ────────────────────────────────────────────────────
export {
  type Profile,
  type Skill,
  type ModelConfig,
  type RuntimeConfig,
  type ToolPolicy,
} from "./profile.js";

// ── Loader ────────────────────────────────────────────────────
export {
  type ProfileSource,
  FilesystemProfileSource,
  loadProfiles,
  loadProfile,
} from "./loader.js";

// ── System prompt assembler ───────────────────────────────────
export {
  type BlackboardHeadings,
  type RuntimeContext,
  type PromptAssemblyOptions,
  assembleSystemPrompt,
  assembleProfilePrompt,
} from "./system-prompt.js";
