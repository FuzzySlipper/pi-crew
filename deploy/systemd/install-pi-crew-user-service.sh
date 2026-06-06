#!/usr/bin/env bash
set -euo pipefail

show_help() {
  cat <<'USAGE'
Usage: deploy/systemd/install-pi-crew-user-service.sh [--apply] [--no-start] [--force-config]

Prepare or install the pi-crew systemd --user service in the current user scope.

Default mode is a dry run: print the intended user-scoped changes without writing files
or starting services. Pass --apply to create/update user-scoped files and optionally
start the service.

Environment overrides:
  PI_CREW_REPO_DIR              Repo checkout path (default: $HOME/pi-crew)
  PI_DEN_CORE_URL               Den Core URL (default: http://den-k8plus:3030)
  PI_DEN_CHANNELS_URL           Den Channels WS URL (default: ws://den-k8plus:4201)
  PI_DEN_CHANNELS_TOKEN         Optional token; never printed by this script
  PI_DEN_MCP_ENDPOINT           Den MCP endpoint (default: http://den-k8plus:3100/mcp)
  PI_CREW_HEALTH_HOST           Health bind host (default: 127.0.0.1)
  PI_CREW_HEALTH_PORT           Health port (default: 9236)
USAGE
}

apply=false
start_service=true
force_config=false

for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    --dry-run) apply=false ;;
    --no-start) start_service=false ;;
    --force-config) force_config=true ;;
    -h|--help) show_help; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; show_help >&2; exit 2 ;;
  esac
done

repo_dir="${PI_CREW_REPO_DIR:-$HOME/pi-crew}"
unit_source="$repo_dir/deploy/systemd/pi-crew.service"
unit_dir="$HOME/.config/systemd/user"
unit_path="$unit_dir/pi-crew.service"
config_dir="$HOME/.config/pi-crew"
config_path="$config_dir/config.yaml"
state_dir="$HOME/.local/state/pi-crew"
state_db="$state_dir/runtime.db"
health_host="${PI_CREW_HEALTH_HOST:-127.0.0.1}"
health_port="${PI_CREW_HEALTH_PORT:-9236}"
core_url="${PI_DEN_CORE_URL:-http://den-k8plus:3030}"
channels_url="${PI_DEN_CHANNELS_URL:-ws://den-k8plus:4201}"
mcp_endpoint="${PI_DEN_MCP_ENDPOINT:-http://den-k8plus:3100/mcp}"
channels_token="${PI_DEN_CHANNELS_TOKEN:-}"

if [[ ! -f "$unit_source" ]]; then
  echo "unit template not found: $unit_source" >&2
  exit 1
fi

commit="unknown"
if command -v git >/dev/null 2>&1 && [[ -d "$repo_dir/.git" ]]; then
  commit="$(git -C "$repo_dir" rev-parse HEAD)"
fi

redacted_token_state="absent"
if [[ -n "$channels_token" ]]; then
  redacted_token_state="provided-redacted"
fi

cat <<SUMMARY
pi-crew user-service deployment plan
  mode:              $([[ "$apply" == true ]] && echo apply || echo dry-run)
  start service:     $start_service
  repo:              $repo_dir
  commit:            $commit
  unit source:       $unit_source
  unit path:         $unit_path
  config path:       $config_path
  state dir:         $state_dir
  runtime db:        $state_db
  health URL:        http://$health_host:$health_port/
  Den Core URL:      $core_url
  Channels URL:      $channels_url
  Channels token:    $redacted_token_state
SUMMARY

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --user verify "$unit_source"
fi

if [[ "$apply" != true ]]; then
  cat <<'DRYRUN'
Dry run only. To install/start from the user scope, run:
  deploy/systemd/install-pi-crew-user-service.sh --apply

Rollback after apply:
  systemctl --user disable --now pi-crew.service || true
  rm -f ~/.config/systemd/user/pi-crew.service
  systemctl --user daemon-reload
DRYRUN
  exit 0
fi

mkdir -p "$unit_dir" "$config_dir" "$state_dir"
chmod 0700 "$config_dir" "$state_dir"

template_unit="$(<"$unit_source")"
template_unit="${template_unit//Documentation=file:%h\/pi-crew/Documentation=file:$repo_dir}"
template_unit="${template_unit//WorkingDirectory=%h\/pi-crew/WorkingDirectory=$repo_dir}"
printf '%s\n' "$template_unit" > "$unit_path"
chmod 0644 "$unit_path"

if [[ -e "$config_path" && "$force_config" != true ]]; then
  echo "preserving existing config: $config_path"
  echo "pass --force-config to overwrite it"
else
  umask 077
  cat > "$config_path" <<CONFIG
den:
  coreUrl: "$core_url"
  channelsUrl: "$channels_url"
  channelsToken: "$channels_token"
  channelsRetryMaxAttempts: 5
  channelsRetryBaseDelayMs: 200
  channelsRetryMaxDelayMs: 30000
  channelsPingIntervalMs: 30000
  channelsConnectionTimeoutMs: 10000
  requiredAtStartup: true

mcp:
  transport: "streamable-http"
  endpoint: "$mcp_endpoint"
  requestTimeout: 30000
  maxReconnectAttempts: 3
  reconnectBaseDelay: 1000

database:
  path: "$state_db"
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
  port: $health_port
  host: "$health_host"
CONFIG
fi

npm --prefix "$repo_dir" ci
npm --prefix "$repo_dir" run build
systemctl --user daemon-reload
systemctl --user cat pi-crew.service >/dev/null

if [[ "$start_service" == true ]]; then
  systemctl --user enable --now pi-crew.service
  systemctl --user status pi-crew.service --no-pager
  curl -fsS "http://$health_host:$health_port/"
else
  systemctl --user enable pi-crew.service
fi

cat <<DONE

Installed pi-crew user service.
Evidence commands:
  systemctl --user status pi-crew.service --no-pager
  journalctl --user -u pi-crew.service -n 100 --no-pager
  curl -fsS http://$health_host:$health_port/
  test -e "$state_db" && echo state-db-present
DONE
