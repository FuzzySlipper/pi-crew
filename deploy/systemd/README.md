# pi-crew — den-k8 `systemd --user` deployment assets

This directory contains the user-scoped service unit and runbook for running pi-crew on `den-k8` with repo code in `/home/dev/pi-crew` and pi-crew-owned runtime config/data in `/home/agents/pi-crew`.

## Scope boundary

- Use `systemctl --user` only.
- Install the unit under `~/.config/systemd/user/pi-crew.service`.
- Store installed config under `/home/agents/pi-crew/config.yaml`.
- Store inherited worker profiles under `/home/agents/pi-crew/profiles`.
- Store runtime state under `/home/agents/pi-crew/runtime.db`.
- Do not edit `/etc/systemd/system`, sudoers, system accounts, firewall rules, or root-owned service directories for this deployment path.

## File layout

| Path | Purpose |
|------|---------|
| `deploy/systemd/pi-crew.service` | Versioned unit template |
| `~/.config/systemd/user/pi-crew.service` | Installed user unit |
| `/home/agents/pi-crew/config.yaml` | Installed runtime config |
| `/home/agents/pi-crew/profiles/` | Installed worker profile root |
| `/home/agents/pi-crew/runtime.db` | SQLite runtime state |
| `/home/dev/pi-crew/` | Repo checkout used by the unit |

## Prerequisites on den-k8

```bash
node --version   # expected >= 20
npm --version
cd /home/dev/pi-crew
npm ci
npm run build
```

## Runtime config template

Create `/home/agents/pi-crew/config.yaml` with mode `0600` if it contains a token. The config parser does not expand `~`, so use absolute paths:

```bash
mkdir -p /home/agents/pi-crew/profiles
cat > /home/agents/pi-crew/config.yaml <<EOF
install:
  root: "/home/agents/pi-crew"

profiles:
  root: "/home/agents/pi-crew/profiles"

den:
  coreUrl: "http://192.168.1.10:18080/den-core-api"
  channelsUrl: "http://192.168.1.10:18081"
  channelsToken: ""
  channelsProjectId: "pi-crew"
  channelsMemberIdentity: "pi-crew-runner"
  channelsProfileIdentity: "pi-crew-runner"
  channelsMemberRole: "runner"
  channelsSubscriptionChannelId: "642"
  channelsAgentInstanceId: "pi-crew-runner-live"
  channelsSessionOwnerId: "owner:den-k8plus:pi-crew-runner"
  channelsSessionId: "sess-pi-crew-runner-live"
  channelsSubscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-live"
  channelsAllowLegacyDirectPolling: false
  channelsPollIntervalMs: 5000
  channelsPollLimit: 10
  channelsRetryMaxAttempts: 5
  channelsRetryBaseDelayMs: 200
  channelsRetryMaxDelayMs: 30000
  channelsPingIntervalMs: 30000
  channelsConnectionTimeoutMs: 10000
  requiredAtStartup: true

mcp:
  transport: "streamable-http"
  endpoint: "http://192.168.1.10:5199/mcp"
  requestTimeout: 30000
  maxReconnectAttempts: 3
  reconnectBaseDelay: 1000

database:
  path: "/home/agents/pi-crew/runtime.db"
  wal: true

sessions:
  maxTotal: 16
  maxPerProfile: 4
  idleTimeoutMs: 28800000
  fallbackProfileId: "system-architect"

logging:
  level: "info"
  json: false

health:
  port: 9236
  host: "127.0.0.1"
EOF
chmod 0600 /home/agents/pi-crew/config.yaml
```

If the live Channels endpoint requires a token, inject it in the installed config only and redact it from logs/messages as `[REDACTED]`.

## Install commands

Preferred scripted install (default mode is a dry run):

```bash
cd /home/dev/pi-crew
# Optional when the checkout is not /home/dev/pi-crew:
# export PI_CREW_REPO_DIR=/absolute/path/to/pi-crew
deploy/systemd/install-pi-crew-user-service.sh --dry-run
deploy/systemd/install-pi-crew-user-service.sh --apply
```

Manual equivalent:

```bash
mkdir -p ~/.config/systemd/user /home/agents/pi-crew/profiles
cp /home/dev/pi-crew/deploy/systemd/pi-crew.service ~/.config/systemd/user/pi-crew.service
chmod 0644 ~/.config/systemd/user/pi-crew.service
chmod 0700 /home/agents/pi-crew /home/agents/pi-crew/profiles
# Write /home/agents/pi-crew/config.yaml from the template above, then:
chmod 0600 /home/agents/pi-crew/config.yaml
systemctl --user daemon-reload
systemctl --user enable --now pi-crew.service
```

## Status, logs, and health

```bash
systemctl --user status pi-crew.service --no-pager
systemctl --user is-active pi-crew.service
journalctl --user -u pi-crew.service -n 100 --no-pager
journalctl --user -u pi-crew.service -f
curl -fsS http://127.0.0.1:9236/
```

Expected health response shape:

```json
{"status":"ok","uptime":1.23}
```

## Restart / upgrade

```bash
cd /home/dev/pi-crew
git fetch --all --prune
git checkout main
git pull --ff-only
npm ci
npm run build
systemctl --user restart pi-crew.service
systemctl --user status pi-crew.service --no-pager
curl -fsS http://127.0.0.1:9236/
```

## Unit validation

Preferred syntax validation when available:

```bash
systemd-analyze --user verify /home/dev/pi-crew/deploy/systemd/pi-crew.service
```

Fallback readback after installing the unit:

```bash
systemctl --user daemon-reload
systemctl --user cat pi-crew.service >/dev/null
systemctl --user show pi-crew.service -p LoadState -p FragmentPath --no-pager
```

## Disable and rollback

Rollback is intentionally user-scoped:

```bash
systemctl --user disable --now pi-crew.service || true
rm -f ~/.config/systemd/user/pi-crew.service
systemctl --user daemon-reload
systemctl --user reset-failed pi-crew.service || true
```

Preserve config/state by default for investigation. Remove them only when a clean slate is explicitly desired:

```bash
rm -f /home/agents/pi-crew/config.yaml
rm -rf /home/agents/pi-crew/runtime.db /home/agents/pi-crew/profiles
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Unit fails to load | `systemd-analyze --user verify ~/.config/systemd/user/pi-crew.service` |
| Service exits immediately | `journalctl --user -u pi-crew.service -n 100 --no-pager` |
| `npm` unavailable | `command -v npm`; unit uses `/usr/bin/env npm` |
| Config rejected | Check `/home/agents/pi-crew/config.yaml`; `den.channelsUrl` must be empty, HTTP(S), or legacy WebSocket; HTTP mode also requires `channelsProjectId` and `channelsMemberIdentity`; `profiles.root` must exist if configured |
| Health check fails | Confirm `health.host`/`health.port`; inspect journal for startup errors |
| Den Channels polling/reconnect issue | Check `den.channelsUrl`, project/member identity, token, and endpoint reachability from den-k8 |
