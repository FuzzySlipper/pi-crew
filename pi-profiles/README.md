# pi-profiles

`pi-profiles` loads static profile configuration for pi-crew agents. Runtime conversation state, Den task state, and channel state do not belong in profiles.

## Supported layouts

### Legacy flat layout

Existing profiles remain supported:

```text
profiles/
  pi-crew-runner.profile.yaml
  pi-crew-runner.profile.md
```

The markdown sidecar is optional for legacy profiles. When it is missing, the YAML `systemPrompt` field is used.

### Directory layout with inheritance

New pooled-worker profiles should use the directory layout:

```text
profiles/
  base-worker/
    profile.yaml
    soul.md
  coder/
    profile.yaml
    soul.md
  reviewer/
    profile.yaml
    soul.md
```

`profile.yaml` contains metadata/config. `soul.md` is the supported system-prompt sidecar name and is required for directory profiles.

A child profile can inherit common config:

```yaml
# profiles/coder/profile.yaml
extends: base-worker
name: Coder
skills:
  - name: implementation
    description: Implement scoped code changes.
    version: "0.1.0"
modelConfig:
  temperature: 0.2
toolPolicy:
  allow:
    - terminal
    - file
```

## Merge rules

Inheritance is deterministic and fail-closed:

- Scalars override parent values.
- Objects merge recursively.
- Arrays replace parent arrays.
- `soul.md` prompts compose as parent prompt plus child prompt with explicit section markers.
- Missing parents, inheritance cycles, missing/empty `soul.md`, malformed profile YAML, and invalid merged profiles throw `ConfigurationError` during startup/load.

## Avoiding redundant profile copies

Put shared worker defaults in a base profile such as `base-worker`:

- common description/guardrail text in `base-worker/soul.md`;
- shared provider/model defaults in `base-worker/profile.yaml`;
- shared tool policy defaults in `base-worker/profile.yaml`.

Role profiles should only override the deltas: role name, role-specific prompt section, role-specific skills, and small model/tool differences. Do not copy a whole parent profile into each role.
