#!/usr/bin/env bash
# Install Websidian + the websidian OpenClaw plugin into a native OpenClaw state dir (macOS, Linux, or Git Bash on
# Windows). The container recipe is install-into-container.sh; this one targets ~/.openclaw directly.
#
#   bash integrations/openclaw/websidian/deploy/install-local.sh [options]
#
# Options:
#   --state-dir DIR     OpenClaw state dir (default: $OPENCLAW_STATE_DIR, else ~/.openclaw)
#   --app-dir DIR       Websidian runtime  (default: <state-dir>/plugin-data/websidian/app)
#   --plugin-dir DIR    Plugin files       (default: <state-dir>/plugin-data/websidian/plugin)
#   --no-smoke          Skip the /_health smoke test
#   --dry-run           Print what would happen, change nothing
#   -h, --help          This text
#
# It copies files and runs `npm ci` inside app_dir. It does NOT edit openclaw.json, register the plugin, or restart
# the Gateway: the commands for that are printed at the end, so you choose when to take the interruption.

set -euo pipefail

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit "${1:-0}"; }

STATE_DIR="${OPENCLAW_STATE_DIR:-}"
APP_DIR=""
PLUGIN_DIR=""
SMOKE=1
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --plugin-dir) PLUGIN_DIR="$2"; shift 2 ;;
    --no-smoke) SMOKE=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO"
[ -f src/server.js ] || { echo "src/server.js not found next to this script (is this the Websidian checkout?)" >&2; exit 1; }
SRC_PLUGIN="$REPO/integrations/openclaw/websidian"

STATE_DIR="${STATE_DIR:-$HOME/.openclaw}"
APP_DIR="${APP_DIR:-$STATE_DIR/plugin-data/websidian/app}"
PLUGIN_DIR="${PLUGIN_DIR:-$STATE_DIR/plugin-data/websidian/plugin}"

NODE="${NODE:-node}"
command -v "$NODE" >/dev/null 2>&1 || { echo "node not found on PATH (Node 22 or later is required by OpenClaw)." >&2; exit 1; }
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node $("$NODE" -v) is too old: Websidian needs Node 20 or later." >&2; exit 1; }

REVISION="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
STAMP="{\"revision\": \"$REVISION\", \"installed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"source\": \"$REPO\", \"component\": \"%s\"}"

run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi; }

echo "Websidian checkout: $REPO ($REVISION)"
echo "State dir:          $STATE_DIR"
echo "Runtime (app_dir):  $APP_DIR"
echo "Plugin:             $PLUGIN_DIR"

# 1. The runtime: src/, public/, package.json, package-lock.json, then npm ci inside it (never in the checkout).
run mkdir -p "$APP_DIR"
run rm -rf "$APP_DIR/src" "$APP_DIR/public"
for entry in src public package.json package-lock.json; do run cp -R "$REPO/$entry" "$APP_DIR/$entry"; done
run npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund
if [ "$DRY" = 1 ]; then echo "+ write $APP_DIR/websidian.version"; else printf "$STAMP\n" runtime > "$APP_DIR/websidian.version"; fi

# 2. The plugin.
run rm -rf "$PLUGIN_DIR"
run mkdir -p "$(dirname "$PLUGIN_DIR")"
run cp -R "$SRC_PLUGIN" "$PLUGIN_DIR"
run rm -rf "$PLUGIN_DIR/test" "$PLUGIN_DIR/deploy"
if [ "$DRY" = 1 ]; then echo "+ write $PLUGIN_DIR/websidian.version"; else printf "$STAMP\n" plugin > "$PLUGIN_DIR/websidian.version"; fi

# 3. Smoke test: boot the installed runtime on a throw-away vault and ask it for /_health.
if [ "$SMOKE" = 1 ] && [ "$DRY" = 0 ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$TMP/vault"; echo "# Smoke" > "$TMP/vault/Smoke.md"
  PORT=$((18500 + RANDOM % 400))
  printf '{"host":"127.0.0.1","port":%s,"warm":false,"cacheDir":"%s/cache","sites":[{"slug":"smoke","root":"%s/vault","untrusted":true}]}\n' "$PORT" "$TMP" "$TMP" > "$TMP/config.json"
  WEBSIDIAN_CONFIG="$TMP/config.json" "$NODE" "$APP_DIR/src/server.js" > "$TMP/server.log" 2>&1 &
  PID=$!
  ok=0
  for _ in $(seq 1 40); do
    if "$NODE" -e "fetch('http://127.0.0.1:$PORT/_health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ok=1; break; fi
    sleep 0.5
  done
  kill "$PID" 2>/dev/null || true
  if [ "$ok" = 1 ]; then echo "Smoke test: /_health answered from $APP_DIR"; else echo "Smoke test FAILED; log:" >&2; cat "$TMP/server.log" >&2; exit 1; fi
fi

cat <<EOF

Installed. Now, when you are ready for the interruption:

  openclaw plugins install --link "$PLUGIN_DIR"
  # configure plugins.entries.websidian.config.vaults in openclaw.json (see README.md)
  openclaw gateway restart

Then open http://127.0.0.1:18789/plugins/websidian/ and sign in with the Gateway token.
EOF
