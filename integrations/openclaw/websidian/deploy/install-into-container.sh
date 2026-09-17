#!/usr/bin/env bash
# Install Websidian + the websidian OpenClaw plugin into a running OpenClaw Docker container (e.g. alpine/openclaw).
#
#   bash integrations/openclaw/websidian/deploy/install-into-container.sh <container> [options]
#
# Options:
#   --state-dir DIR     OpenClaw state dir inside the container (default: /home/node/.openclaw)
#   --user USER         User to run npm as inside the container (default: node)
#   --register          Also run `openclaw plugins install --link` inside the container
#   --no-smoke          Skip the /_health smoke test
#   -h, --help          This text
#
# It copies the runtime to <state-dir>/plugin-data/websidian/app, runs `npm ci --omit=dev` there with the
# container's own node, copies the plugin to <state-dir>/plugin-data/websidian/plugin and stamps both. It does NOT
# edit openclaw.json or restart the container unless asked (--register registers the plugin; the restart is yours).

set -euo pipefail

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit "${1:-0}"; }

[ $# -ge 1 ] || usage 1
CONTAINER="$1"; shift
STATE_DIR="/home/node/.openclaw"
RUN_USER="node"
SMOKE=1
REGISTER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --register) REGISTER=1; shift ;;
    --no-smoke) SMOKE=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
[ -f "$REPO/src/server.js" ] || { echo "src/server.js not found (is this the Websidian checkout?)" >&2; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "container $CONTAINER not found" >&2; exit 1; }

DATA="$STATE_DIR/plugin-data/websidian"
APP_DIR="$DATA/app"
PLUGIN_DIR="$DATA/plugin"
REVISION="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
dexec() { docker exec -u "$RUN_USER" "$CONTAINER" sh -c "$1"; }

# Stage a clean copy on the host, then stream each component in with tar (docker cp mangles "dir/." under Git Bash).
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/app" "$STAGE/plugin"
for entry in src public package.json package-lock.json; do cp -R "$REPO/$entry" "$STAGE/app/$entry"; done
cp -R "$REPO/integrations/openclaw/websidian/." "$STAGE/plugin/"
rm -rf "$STAGE/plugin/test" "$STAGE/plugin/deploy" "$STAGE/plugin/node_modules"
printf '{"revision": "%s", "installed_at": "%s", "source": "%s", "component": "runtime"}\n' "$REVISION" "$NOW" "$REPO" > "$STAGE/app/websidian.version"
printf '{"revision": "%s", "installed_at": "%s", "source": "%s", "component": "plugin"}\n' "$REVISION" "$NOW" "$REPO" > "$STAGE/plugin/websidian.version"

echo "Installing Websidian $REVISION into $CONTAINER:$DATA"
# Files a previous run copied in belong to root (docker cp); make them the user's before touching them.
chown_data() { docker exec -u root "$CONTAINER" sh -c "mkdir -p '$DATA' && chown -R '$RUN_USER' '$DATA'" 2>/dev/null || dexec "mkdir -p '$DATA'"; }
chown_data
# Everything but node_modules is replaced (a stale src/ or public/ must not survive an upgrade).
dexec "mkdir -p '$APP_DIR' '$PLUGIN_DIR' && find '$APP_DIR' -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + && find '$PLUGIN_DIR' -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
# (sh -c strings keep Git Bash from rewriting the container paths as Windows paths.)
tar -C "$STAGE/app" -cf - . | docker exec -i -u "$RUN_USER" "$CONTAINER" sh -c "tar -C '$APP_DIR' -xf -"
tar -C "$STAGE/plugin" -cf - . | docker exec -i -u "$RUN_USER" "$CONTAINER" sh -c "tar -C '$PLUGIN_DIR' -xf -"
dexec "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"

if [ "$SMOKE" = 1 ]; then
  dexec "T=\$(mktemp -d) && mkdir -p \$T/vault && echo '# Smoke' > \$T/vault/Smoke.md \
    && printf '{\"host\":\"127.0.0.1\",\"port\":18599,\"warm\":false,\"cacheDir\":\"%s/cache\",\"sites\":[{\"slug\":\"smoke\",\"root\":\"%s/vault\",\"untrusted\":true}]}' \"\$T\" \"\$T\" > \$T/config.json \
    && (WEBSIDIAN_CONFIG=\$T/config.json node '$APP_DIR/src/server.js' > \$T/server.log 2>&1 & echo \$! > \$T/pid) \
    && ok=0; for i in \$(seq 1 40); do node -e \"fetch('http://127.0.0.1:18599/_health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))\" 2>/dev/null && { ok=1; break; }; sleep 0.5; done; \
    kill \$(cat \$T/pid) 2>/dev/null; if [ \$ok = 1 ]; then echo 'Smoke test: /_health answered from $APP_DIR'; else echo 'Smoke test FAILED:' >&2; cat \$T/server.log >&2; rm -rf \$T; exit 1; fi; rm -rf \$T"
fi

if [ "$REGISTER" = 1 ]; then
  dexec "openclaw plugins install --link '$PLUGIN_DIR'"
fi

cat <<EOF

Installed. Now, when you are ready for the interruption:

$([ "$REGISTER" = 1 ] || echo "  docker exec -u $RUN_USER $CONTAINER openclaw plugins install --link '$PLUGIN_DIR'")
  # configure plugins.entries.websidian.config.vaults in openclaw.json (paths as seen inside the container)
  docker restart $CONTAINER

Then open http://127.0.0.1:<published gateway port>/plugins/websidian/ and sign in with the Gateway token.
EOF
