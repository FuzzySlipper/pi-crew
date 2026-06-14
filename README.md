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

`pi-crew-debug` is a first-pass high-trust diagnostic client for existing service-backed conversational sessions. It talks to the local admin debug API and bypasses Den Channels transport/wake/projection while still routing the turn through `SessionManager`, the conversational runtime, tools, and delegation lifecycle.

```bash
PI_CREW_DEBUG_URL=http://127.0.0.1:9237 pi-crew-debug sessions
PI_CREW_DEBUG_URL=http://127.0.0.1:9237 pi-crew-debug ask --session sess-prime-coder "hello"
PI_CREW_DEBUG_URL=http://127.0.0.1:9237 pi-crew-debug events --session sess-prime-coder --limit 20
PI_CREW_DEBUG_URL=http://127.0.0.1:9237 pi-crew-debug chat --session sess-prime-coder
```

Implementation note: the pi.dev TUI source under `/home/research/pi-fleet/pi/packages/` was inspected. The package is a local terminal UI/agent stack, not a small remote-session client seam, so the first working #2410 path uses the minimal standalone CLI instead of force-fitting the TUI. Future work can wrap the same `/debug/*` API in a richer TUI.

Known limitation: `/debug/*` is intentionally unauthenticated for the initial high-trust LAN/local diagnostic pass. Do not expose it outside the trusted operator network until a later hardening task adds auth/roles/TLS/CSRF posture.

## Runtime and deployment caveat

The live service can be deployed as a persistent runtime, but deployment state is not inferred from this checkout alone. Treat Den task threads, completion packets, review rounds, live smoke evidence, and operator deployment notes as authoritative for what is running. Code review/merge and live deployment/smoke are separate gates.

## Diagnostics and remediation boundary

`pi-service/src/diagnostics` contains the read-only runtime diagnostic projection used by the V2 safe-remediation work. It joins local session records, Den assignment readback, runtime DB health, connectivity readers, and a bounded redacted event journal into operator-facing read models. The projection is diagnostic evidence only: Den remains authoritative for tasks, assignments, worker runs, review state, messages, and completion packets.

Safe remediation controls must build on this projection without adding an alternate workflow ledger, arbitrary shell/file endpoints, or Den-bypassing mutation paths. If local runtime state and Den readback disagree, the projection classifies the disagreement and the operator path must fail closed unless a later task explicitly proves a Den-authoritative recovery action.

## Status framing

V1 established the background-agent foundation: service runtime, Den Channels HTTP/direct-agent ingress, cursor/replay safety, deterministic response path, and lifecycle telemetry compatibility evidence. V2 is about turning that foundation into a trusted Den worker substrate: real supervised worker roles, Den-authoritative completions, policy enforcement, context/drain behavior, diagnostics, and safe operator controls.

Avoid commit-heavy or one-session status claims here. For current status, read Den tasks under the `pi-crew` project, especially parent roadmap task #2046 and the V2 roadmap document.
