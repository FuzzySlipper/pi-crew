# pi-crew — den-k8 `systemd --user` deployment

User-scoped deployment for running pi-crew on `den-k8` under the agent user.
No root, sudo, system accounts, or firewall changes required.

## File layout

| Path | Purpose |
|------|---------|
| `~/.config/systemd/user/pi-crew.service` | Unit file (copy from `deploy/systemd/pi-crew.service`) |
| `~/.config/pi-crew/config.yaml` | pi-crew runtime config |
| `~/.local/state/pi-crew/runtime.db` | SQLite runtime state (auto-created) |
| `~/pi-crew/` | Repo checkout (this repo) |

## Prerequisites

```bash
# Node.js and npm (den-k8 already has these)
node --version   # >= 20
npm --version

# Install pi-crew dependencies (one-time)
cd ~/pi-crew
npm ci
```

## Install

```bash
# 1. Create user systemd directory if missing
mkdir -p ~/.config/systemd/user

# 2. Copy the unit file into place
cp ~/pi-crew/deploy/systemd/pi-crew.service ~/.config/systemd/user/

# 3. Create config directory
mkdir -p ~/.config/pi-crew

# 4. Create a minimal config (adjust for your Den Channels setup)
cat > ~/.config/pi-crew/config.yaml << 'EOF'
den:
  channels:
    url: "ws://192.168.1.10:8080/ws"
    token: "[REDACTED]"
runtime:
  dbPath: "~/.local/state/pi-crew/runtime.db"
EOF

# 5. Reload user systemd and enable
systemctl --user daemon-reload
systemctl --user enable pi-crew.service
```

## Start / stop / restart

```bash
systemctl --user start pi-crew.service
systemctl --user stop pi-crew.service
systemctl --user restart pi-crew.service
```

## Status and health check

```bash
# Service status
systemctl --user status pi-crew.service

# Recent logs
journalctl --user -u pi-crew.service -n 50

# Follow logs (Ctrl-C to exit)
journalctl --user -u pi-crew.service -f

# Check for WebSocket connect confirmation
journalctl --user -u pi-crew.service | grep -i "connected to Den"

# Is the service active and running?
systemctl --user is-active pi-crew.service
```

## Logs

All output goes to the user journal. No log files on disk by default.

```bash
# Last hour
journalctl --user -u pi-crew.service --since "1 hour ago"

# Last 100 lines, no pager
journalctl --user -u pi-crew.service -n 100 --no-pager

# Export to file
journalctl --user -u pi-crew.service --since today > /tmp/pi-crew-today.log
```

## Disable and rollback

```bash
# 1. Stop the service
systemctl --user stop pi-crew.service

# 2. Disable (prevents auto-start on login)
systemctl --user disable pi-crew.service

# 3. Remove the unit file
rm ~/.config/systemd/user/pi-crew.service

# 4. Reload so systemd forgets it
systemctl --user daemon-reload

# 5. Optionally remove config and state
#    (only do this if you want a clean slate)
rm ~/.config/pi-crew/config.yaml
rm -rf ~/.local/state/pi-crew/
```

## Upgrade (deploy new version)

```bash
cd ~/pi-crew
git pull
npm ci
systemctl --user restart pi-crew.service
```

## Validation

If `systemd-analyze` is available:

```bash
# Verify unit syntax (run from deploy directory)
systemd-analyze --user verify ~/pi-crew/deploy/systemd/pi-crew.service
```

If not available, manual syntax checks:

```bash
# Check that all directives are recognised (quiet = no errors)
systemctl --user cat pi-crew.service > /dev/null 2>&1 && echo "unit readable"

# Verify the unit loads without errors
systemctl --user show pi-crew.service -p LoadState 2>/dev/null

# Check for syntax errors via daemon-reload return code
systemctl --user daemon-reload && echo "syntax OK"
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Service fails to start | `journalctl --user -u pi-crew.service -n 30` |
| `npm` not found in ExecStart | Use full path: `which npm` → `/usr/bin/npm` |
| `@pi-crew/crew` workspace not found | Run `npm ls -w @pi-crew/crew` from `~/pi-crew` |
| Config not loaded | Verify `PI_CREW_CONFIG` path; check file permissions |
| WebSocket refused | Check Den Channels is running on the configured host:port |
