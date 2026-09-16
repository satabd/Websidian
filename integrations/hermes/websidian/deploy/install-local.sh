#!/usr/bin/env bash
# Install Websidian + the websidian Hermes plugin into a native Hermes profile (macOS, Linux, or Git Bash
# on Windows). The container recipe is install-into-container.sh; this one targets ~/.hermes directly.
#
#   bash integrations/hermes/websidian/deploy/install-local.sh [options]
#
# Options:
#   --hermes-home DIR   Hermes profile (default: $HERMES_HOME, else ~/.hermes)
#   --app-dir DIR       Websidian runtime  (default: <hermes-home>/plugin-data/websidian/app)
#   --plugin-dir DIR    Plugin files       (default: <hermes-home>/plugins/websidian)
#   --no-smoke          Skip the /_health smoke test
#   --dry-run           Print what would happen, change nothing
#   -h, --help          This text
#
# It copies files and runs `npm ci` inside app_dir. It does NOT edit config.yaml, enable the plugin,
# or restart the dashboard or the gateway: the commands for that are printed at the end, so you choose
# when to take the interruption.

set -euo pipefail

# Print the comment block above (everything after the shebang, up to the first line of code).
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit "${1:-0}"; }

HERMES_HOME="${HERMES_HOME:-}"
APP_DIR=""
PLUGIN_DIR=""
SMOKE=1
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hermes-home) HERMES_HOME="$2"; shift 2 ;;
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

if [ -z "$HERMES_HOME" ]; then
  if [ -d "$HOME/.hermes" ]; then HERMES_HOME="$HOME/.hermes"
  elif [ -n "${LOCALAPPDATA:-}" ] && [ -d "$LOCALAPPDATA/hermes" ]; then HERMES_HOME="$LOCALAPPDATA/hermes"
  else HERMES_HOME="$HOME/.hermes"; fi
fi
APP_DIR="${APP_DIR:-$HERMES_HOME/plugin-data/websidian/app}"
PLUGIN_DIR="${PLUGIN_DIR:-$HERMES_HOME/plugins/websidian}"

NODE="${NODE:-node}"
command -v "$NODE" >/dev/null 2>&1 || { echo "node not found on PATH (Node 20 or later is required)." >&2; exit 1; }
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node $("$NODE" -v) is too old: Websidian needs Node 20 or later." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm not found on PATH." >&2; exit 1; }

echo "Repository : $REPO"
echo "Hermes home: $HERMES_HOME"
echo "App dir    : $APP_DIR"
echo "Plugin dir : $PLUGIN_DIR"
echo "Node       : $("$NODE" -v)"
if [ "$DRY" = 1 ]; then echo; echo "--dry-run: nothing was changed."; exit 0; fi
if [ ! -d "$HERMES_HOME" ]; then
  echo "Hermes home $HERMES_HOME does not exist. Run Hermes once, or pass --hermes-home." >&2; exit 1
fi

echo
echo "==> Copying the Websidian runtime into $APP_DIR"
mkdir -p "$APP_DIR"
# Replace the code directories so files deleted upstream do not linger; keep cache/ and anything else.
rm -rf "$APP_DIR/src" "$APP_DIR/public"
cp -R src "$APP_DIR/src"
cp -R public "$APP_DIR/public"
cp package.json package-lock.json "$APP_DIR/"

echo "==> Installing runtime dependencies in $APP_DIR (npm ci --omit=dev)"
# --prefix is what puts node_modules in app_dir rather than in the caller's working directory.
npm --prefix "$APP_DIR" ci --omit=dev --ignore-scripts

echo "==> Copying the plugin into $PLUGIN_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -cf "$STAGE/plugin.tar" --exclude=tests --exclude=__pycache__ --exclude=deploy -C integrations/hermes websidian
mkdir -p "$STAGE/x" "$(dirname "$PLUGIN_DIR")"
tar -xf "$STAGE/plugin.tar" -C "$STAGE/x"
rm -rf "$PLUGIN_DIR"
mv "$STAGE/x/websidian" "$PLUGIN_DIR"

echo "==> Checking the installed layout"
fail=0
for f in "$APP_DIR/src/server.js" "$APP_DIR/package.json" "$PLUGIN_DIR/plugin.yaml" "$PLUGIN_DIR/dashboard/manifest.json" "$PLUGIN_DIR/dashboard/plugin_api.py"; do
  if [ -e "$f" ]; then echo "    ok  $f"; else echo "    MISSING  $f"; fail=1; fi
done
if [ -d "$APP_DIR/node_modules" ]; then echo "    ok  $APP_DIR/node_modules"; else echo "    MISSING  $APP_DIR/node_modules"; fail=1; fi
[ "$fail" = 0 ] || { echo "Installation is incomplete." >&2; exit 1; }

if [ "$SMOKE" = 1 ]; then
  echo "==> Smoke test: starting the installed Websidian on a throw-away vault"
  SMOKE_DIR="$STAGE/smoke"
  mkdir -p "$SMOKE_DIR/vault"
  # Git Bash: node is a Windows program, so the config must hold Windows paths.
  if command -v cygpath >/dev/null 2>&1; then J="$(cygpath -m "$SMOKE_DIR")"; else J="$SMOKE_DIR"; fi
  printf '# Hello\n\nInstalled.\n' > "$SMOKE_DIR/vault/Hello.md"
  PORT="$(( 18000 + RANDOM % 2000 ))"
  cat > "$SMOKE_DIR/config.json" <<EOF
{"port": $PORT, "host": "127.0.0.1", "cacheDir": "$J/cache", "warm": false,
 "sites": [{"slug": "smoke", "title": "Smoke", "root": "$J/vault", "untrusted": true}]}
EOF
  WEBSIDIAN_CONFIG="$SMOKE_DIR/config.json" "$NODE" "$APP_DIR/src/server.js" > "$SMOKE_DIR/server.log" 2>&1 &
  SMOKE_PID=$!
  trap 'kill "$SMOKE_PID" 2>/dev/null || true; rm -rf "$STAGE"' EXIT
  ok=0
  for _ in $(seq 1 40); do
    if body="$(curl -fsS "http://127.0.0.1:$PORT/_health" 2>/dev/null)"; then ok=1; break; fi
    sleep 0.25
  done
  kill "$SMOKE_PID" 2>/dev/null || true
  if [ "$ok" = 1 ]; then
    echo "    ok  GET /_health -> $body"
  else
    echo "    FAILED: /_health did not answer. Server log:" >&2
    sed -n '1,40p' "$SMOKE_DIR/server.log" >&2
    exit 1
  fi
fi

cat <<EOF

Done. Nothing was enabled or restarted and config.yaml was not touched.

Next steps (yours to run, in this order):

  1. Enable the plugin. Decline the "replace built-in tools" prompt: this plugin works through hooks and
     its own websidian_links tool and does not need --allow-tool-override.
       hermes plugins enable websidian
       hermes plugins list --plain          # expect: websidian ... enabled

  2. Point it at your vaults and the dashboard tab (JSON literals; only these keys are written):
       hermes config set plugins.entries.websidian.settings.dashboard '{"port": 8095, "app_dir": "$APP_DIR", "node": "node", "public_base": "http://localhost:9119"}'
       hermes config set plugins.entries.websidian.settings.link_style dashboard
       hermes config set plugins.entries.websidian.settings.vaults '[{"path": "$HOME/Documents/Obsidian Vault", "slug": "brain", "title": "Second Brain"}]'
     Vaults are untrusted unless you set "untrusted": false, which you should not for anything an agent
     writes to. Browser editing is off unless you add "edit": true to a vault — and then every signed-in
     dashboard user can rewrite it, so turn it on only for a vault you chose deliberately.

  3. Restart, when it suits you. Enabled is not the same as active:
       - the dashboard must restart before the Websidian tab and its supervised server exist;
       - the gateway must restart before the write guard and the reply links load in chat.
       hermes dashboard --status
     Then open http://localhost:9119/websidian.

  4. Check it in the browser, signed in. The tab's routes live under /api/plugins/, behind the dashboard's
     auth gate: an ungated local dashboard shows /websidian and still answers 401 there. Both of these must
     load through your session:
       /api/plugins/websidian/status
       /api/plugins/websidian/w/<slug>/
     If they 401, put the dashboard in its gated mode (basic auth on a LAN/VPN, OAuth if it faces the
     internet). Never weaken or remove dashboard authentication to make the tab work.

Files it generates: $HERMES_HOME/plugin-data/websidian/{websidian.config.json,secrets.json,server.log,server.pid,cache/}
EOF
