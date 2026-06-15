# pi-crew

`pi-crew` is a TypeScript monorepo for experimenting with Den-visible Pi-side worker/runtime primitives. It is a runtime substrate, not a separate workflow ledger: **Den docs, Den tasks, Den messages, review rounds, worker runs, and completion packets are authoritative.** This README is only a secondary map for humans or agents who land in the git checkout.

Canonical repo root: `/home/dev/pi-crew`.

Do **not** use the Hermes repo (`/home/dev/den-hermes` or `/home/agent/.hermes/hermes-agent`) as the pi-crew source tree. Hermes material in Den is reference/context for feature porting, not the implementation checkout.

## Authoritative Den references

Start from Den when you need current requirements or task state. Key Den document slugs:

- `architecture-audit-june-2026` — architecture baseline, V1 status, and hygiene recommendations.
- `repo-root-and-audit-scope` — canonical repo root and warning against accidentally auditing Hermes instead.
- `den-worker-runtime-contract` — Den-facing worker lifecycle, completion packet, policy, context pressure, and release contract.
- `submodule-architecture` — package boundaries and dependency arrows.
- `codebase-constitution` — file-size, TypeScript strictness, testing, dependency-injection, and no-barrel conventions.
- `v2-worker-substrate-roadmap` — high-level V2 direction and task spine.

## Repo/package map

This repository is organized as independently useful workspace packages:

| Package         | Purpose                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `pi-core`       | Foundational types, typed event bus, repository/channel interfaces, errors, logging, and test fakes. |
| `pi-profiles`   | Profile and skill loading/prompt assembly conventions.                                               |
| `pi-mcp`        | Standalone MCP client and tool discovery/conversion.                                                 |
| `pi-service`    | Daemon/runtime orchestration: sessions, instances, worker runtime, local persistence, health.        |
| `pi-channels`   | ChannelProvider implementations, including Den Channels.                                             |
| `pi-tools`      | Pi-specific tool helpers such as worker policy, drain mode, completion, and context status.          |
| `pi-governance` | Event-bus subscribers for breadcrumbs, audit logging, and output routing.                            |
| `pi-crew`       | Composition root and executable service entrypoint.                                                  |
| `pi-memory`     | Deferred/stub package; Den remains the durable source of truth for workflow state.                   |

Submodule rule of thumb: packages below `pi-service` must not import upward into `pi-service`; platform adapters depend on the `ChannelProvider` interface from `pi-core`, not on each other.

## Common commands

Run from the repo root:

```bash
npm run build
npm run lint
npm test
npm run format
```

Useful focused checks while editing:

```bash
npm test -- pi-tools/src/__tests__/context-status.test.ts
npm test -- pi-core/src/test-helpers/fake-event-bus.test.ts
npm test -- pi-crew/src/__tests__/crew.test.ts
```

## Direct diagnostic chat

`pi-crew-debug` is a first-pass high-trust diagnostic client for existing service-backed full-agent sessions. It talks to the local admin debug API and bypasses Den Channels transport/wake/projection while still routing the turn through `SessionManager`, the conversational runtime, tools, and delegation lifecycle.

```bash
PI_CREW_DEBUG_URL=http://127.0.0.1:9237 pi-crew-debug sessions
PI_CREW_DEBUG_URL=http://127.0.0.1:9237 pi-crew-debug ask --session sess-prime-coder "hello"
PI_CREW_DEBUG_URL=http://127.0.0.1:9237 pi-crew-debug events --session sess-prime-coder --limit 20
PI_CREW_DEBUG_URL=http://127.0.0.1:9237 pi-crew-debug chat --session sess-prime-coder
PI_CREW_DEBUG_URL=http://127.0.0.1:9237 pi-crew-debug tui --session sess-prime-coder
```

The `tui` command is a remote client for the service/debug API. It renders a terminal dashboard with session overview, chat/context, and events panels. Local TUI commands are `/sessions`, `/select <sessionId>`, `/context`, `/events`, `/tools`, `/help`, and `/quit`. Other slash input such as `/status`, `/new`, and `/reload-mcp` is sent through `POST /debug/sessions/{sessionId}/turn` so the existing service command router owns command semantics.

The debug API also exposes bounded persisted context for this client:

```bash
curl -s 'http://127.0.0.1:9237/debug/sessions/sess-prime-coder/context?limit=30'
```

Implementation note: the pi.dev TUI source under `/home/research/pi-fleet/pi/packages/` was re-inspected for this TUI pass, especially `packages/tui/src/index.ts`, `packages/tui/src/components/select-list.ts`, `packages/tui/src/editor-component.ts`, and `packages/coding-agent/src/modes/interactive/interactive-mode.ts`. The reusable ideas were the split between terminal rendering, selectable sessions, editor/input, and chat/event components. The code was not imported directly because pi.dev's interactive mode is a local agent/runtime TUI with a large dependency surface and local-agent assumptions; pi-crew's client stays a small remote debug API client and does not read the runtime DB directly.

Known limitation: `/debug/*` is intentionally unauthenticated for the initial high-trust LAN/local diagnostic pass. Do not expose it outside the trusted operator network until a later hardening task adds auth/roles/TLS/CSRF posture.

### Control-plane slash commands

Direct diagnostic turns intercept recognized slash commands before building LLM input. Current command set:

- `/help` — list control-plane commands.
- `/status` or `/session` — return current session/profile/instance/presence diagnostics.
- `/reload-mcp [reason]` — reloads the MCP-discovered/tool surface for the current full-agent profile while preserving the configured session id, instance, channel binding, and persisted message history. It reports old/new tool counts plus added/removed tool names.
- `/new [reason]` — resets the configured full-agent session boundary: releases the old instance, deletes persisted turn history for that session, reacquires a fresh instance with the same configured session/channel binding, and returns old/new instance ids plus archived message count/reset timestamp.

`/reload-mcp` and `/new` are intentionally not aliases. Use `/reload-mcp` to pick up MCP/tool changes without losing context; use `/new` only when the operator wants a fresh conversation boundary.

Admin diagnostics exposes the effective model-callable tool inventory without treating slash commands as tools:

```bash
curl -s http://127.0.0.1:9237/admin/diagnostics/tools
curl -s http://127.0.0.1:9237/admin/diagnostics/tools/sess-prime-coder
curl -s http://127.0.0.1:9237/admin/diagnostics/tools/sess-pi-orchestrator
```

Tool names in pi-crew profile config are the names discovered from the pi-crew MCP registry, typically unprefixed Den MCP names such as `send_message` and `update_task`. Hermes-facing `mcp_den_*` names are facade names and should not be duplicated in pi-crew profile allow lists unless an explicit alias layer is added and tested. Simple YAML quotes around strings are not semantically significant. Profile `mcpConfig.toolProfile` selects the Den MCP `tool_profile` surface; base `config.yaml` should only bind conversational profiles to sessions/channels and keep service-level connection defaults.

### Adding tools to pi-crew

Use the right registration path for the surface you are changing:

1. **Den/MCP-discovered tools** are added or configured in Den MCP/tool profiles. Pi-crew discovers them dynamically through the selected profile's MCP endpoint and `mcpConfig.toolProfile`; do not manually add every Den tool to pi-crew source. Update Den-side docs/profile config when the MCP surface changes, and inspect the live inventory with `/admin/diagnostics/tools/<sessionId>`.
2. **Pi-crew runtime-local model-callable tools** must be registered in the central catalog `pi-crew/src/local-tool-catalog.ts`, assembled in the runtime/tool provider, covered by policy/inventory tests, and listed in this README table. These are local wrappers or built-ins such as delegation/helper/local code tools, not ordinary Den MCP tools.
3. **Slash/control commands** are control-plane inputs handled before LLM prompting. Document them separately in `CONTROL_COMMAND_CATALOG` and the slash-command router; never expose them as model-callable `AgentTool`s.

Checklist for adding a runtime-local model-callable tool:

- Add the implementation/factory and wire it through constructor-injected assembly or a provider; do not hide `new` dependencies inside methods.
- Add a `LOCAL_MODEL_CALLABLE_TOOL_CATALOG` entry with category, implementation path, assembled path, intended surfaces, policy gate, and guardrail test path.
- Add/update selection policy tests proving the tool is selected only when requested and permitted.
- Add/update diagnostics inventory tests so `/admin/diagnostics/tools/<sessionId>` reports the catalog metadata.
- Update this generated table and run `npm test -- pi-crew/src/__tests__/local-tool-catalog.test.ts`.

Current runtime-local model-callable catalog:

| Tool                  | Category   | Surfaces                    | Policy gate                                                                                  | Implemented in                                     |
| --------------------- | ---------- | --------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `spawn_subagent`      | delegation | full-agent                  | runtime.tools.allow/profile toolPolicy must request delegation or spawn_subagent             | `pi-service/src/workers/delegated-spawn-tool.ts`   |
| `fan_out_subagents`   | delegation | full-agent                  | runtime.tools.allow/profile toolPolicy must request delegation or fan_out_subagents          | `pi-service/src/workers/delegated-fan-out-tool.ts` |
| `scout_codebase`      | helper     | full-agent                  | runtime.tools.allow/profile toolPolicy must request delegation or scout_codebase             | `pi-service/src/workers/delegated-helper-tools.ts` |
| `summarize_files`     | helper     | full-agent                  | runtime.tools.allow/profile toolPolicy must request delegation or summarize_files            | `pi-service/src/workers/delegated-helper-tools.ts` |
| `find_relevant_paths` | helper     | full-agent                  | runtime.tools.allow/profile toolPolicy must request delegation or find_relevant_paths        | `pi-service/src/workers/delegated-helper-tools.ts` |
| `read_file`           | local      | full-agent, delegated-child | runtime.tools.allow/profile toolPolicy must request local, filesystem, or concrete tool name | `pi-crew/src/local-code-tools.ts`                  |
| `write_file`          | local      | full-agent, delegated-child | runtime.tools.allow/profile toolPolicy must request local, filesystem, or concrete tool name | `pi-crew/src/local-code-tools.ts`                  |
| `search_files`        | local      | full-agent, delegated-child | runtime.tools.allow/profile toolPolicy must request local, filesystem, or concrete tool name | `pi-crew/src/local-code-tools.ts`                  |
| `terminal`            | local      | full-agent, delegated-child | runtime.tools.allow/profile toolPolicy must request local, terminal, or concrete tool name   | `pi-crew/src/local-code-tools.ts`                  |
| `git_status`          | local      | full-agent, delegated-child | runtime.tools.allow/profile toolPolicy must request local, git, or concrete tool name        | `pi-crew/src/local-code-tools.ts`                  |
| `git_diff`            | local      | full-agent, delegated-child | runtime.tools.allow/profile toolPolicy must request local, git, or concrete tool name        | `pi-crew/src/local-code-tools.ts`                  |

Current slash/control commands: `/help`, `/status`, `/session`, `/new`, `/reload-mcp`. They are not model-callable tools. Unrecognized slash commands and non-command text continue through the normal conversational runtime. Command-only turns return diagnostic/control output without entering the LLM path.

### Full-agent context compaction

Full-agent compaction auto-fires during persisted history loading, immediately before prompt assembly for a full-agent turn. The runtime resolves an effective context policy once per responder/session resolution: den-router models query `GET /v1/models/{model}/metadata` for `context_length`; non-den-router models or missing metadata use `context.defaultContextLength`. The history adapter estimates current persisted conversation usage with the conservative `chars_div_3` estimator and emits `context.pressure` with usage, threshold, estimator, and context-length provenance. When estimated usage reaches `context.compactionThresholdPercent` of the effective context length, older persisted turns are compacted into a `full_agent_context_artifact`; the prompt receives that artifact as a user-role context message plus the newest `context.minimumRecentMessages` raw messages. The old hidden `historyLimit=24` default is not the primary compaction trigger.

Configure in `pi-crew/config/default.yaml` or deployment overrides:

```yaml
context:
  defaultContextLength: 131072
  compactionThresholdPercent: 80
  minimumRecentMessages: 24
```

Diagnostics expose the last pressure/compaction event, including effective context length, provenance (`den-router` or `config-default`), threshold percent/tokens, estimated current usage, and latest artifact id.

## Runtime and deployment caveat

The live service can be deployed as a persistent runtime, but deployment state is not inferred from this checkout alone. Treat Den task threads, completion packets, review rounds, live smoke evidence, and operator deployment notes as authoritative for what is running. Code review/merge and live deployment/smoke are separate gates.

## Diagnostics and remediation boundary

`pi-service/src/diagnostics` contains the read-only runtime diagnostic projection used by the V2 safe-remediation work. It joins local session records, Den assignment readback, runtime DB health, connectivity readers, and a bounded redacted event journal into operator-facing read models. The projection is diagnostic evidence only: Den remains authoritative for tasks, assignments, worker runs, review state, messages, and completion packets.

Safe remediation controls must build on this projection without adding an alternate workflow ledger, arbitrary shell/file endpoints, or Den-bypassing mutation paths. If local runtime state and Den readback disagree, the projection classifies the disagreement and the operator path must fail closed unless a later task explicitly proves a Den-authoritative recovery action.

## Status framing

V1 established the background-agent foundation: service runtime, Den Channels HTTP/direct-agent ingress, cursor/replay safety, deterministic response path, and lifecycle telemetry compatibility evidence. V2 is about turning that foundation into a trusted Den worker substrate: real supervised worker roles, Den-authoritative completions, policy enforcement, context/drain behavior, diagnostics, and safe operator controls.

Avoid commit-heavy or one-session status claims here. For current status, read Den tasks under the `pi-crew` project, especially parent roadmap task #2046 and the V2 roadmap document.
