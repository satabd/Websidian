#!/usr/bin/env bash
# Install Websidian + the websidian Hermes plugin (agent plugin and dashboard tab) into a running Docker container.
#
#   bash integrations/hermes/websidian/deploy/install-into-container.sh [container] [app_dir] [plugin_dir]
#
# Run from the repository root (Git Bash on Windows works). Defaults:
#   container  hermes01
#   app_dir    /root/.hermes/plugin-data/websidian/app
#   plugin_dir /root/.hermes/plugins/websidian
#
# It only copies files: it does NOT restart the gateway or the dashboard and does NOT edit config.yaml
# (the commands to run are printed at the end). Websidian's node_modules are copied from this checkout, so run
# `npm ci` here first; Websidian has no native modules, so a Windows or macOS node_modules works on Linux.
#
# PowerShell equivalent (from the repo root):
#   tar -cf $env:TEMP\websidian-app.tar src public package.json package-lock.json node_modules
#   docker exec hermes01 mkdir -p /root/.hermes/plugin-data/websidian/app
#   docker cp $env:TEMP\websidian-app.tar hermes01:/tmp/websidian-app.tar
#   docker exec hermes01 sh -c "tar -xf /tmp/websidian-app.tar -C /root/.hermes/plugin-data/websidian/app && rm /tmp/websidian-app.tar"
#   tar -cf $env:TEMP\websidian-plugin.tar --exclude=tests --exclude=__pycache__ --exclude=deploy -C integrations/hermes websidian
#   docker cp $env:TEMP\websidian-plugin.tar hermes01:/tmp/websidian-plugin.tar
#   docker exec hermes01 sh -c "mkdir -p /root/.hermes/plugins && tar -xf /tmp/websidian-plugin.tar -C /root/.hermes/plugins && rm /tmp/websidian-plugin.tar"

set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: do not rewrite /root/... container paths

CONTAINER="${1:-hermes01}"
APP_DIR="${2:-/root/.hermes/plugin-data/websidian/app}"
PLUGIN_DIR="${3:-/root/.hermes/plugins/websidian}"

if [ ! -f src/server.js ] || [ ! -d integrations/hermes/websidian ]; then
  echo "Run this from the Websidian repository root (src/server.js not found)." >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "node_modules is missing: run 'npm ci' first." >&2
  exit 1
fi
docker inspect -f '{{.State.Running}}' "$CONTAINER" | grep -q true || { echo "Container $CONTAINER is not running." >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# docker.exe on Windows needs a Windows path for the host side of `docker cp`.
HOST_TMP="$TMP"
if command -v cygpath >/dev/null 2>&1; then HOST_TMP="$(cygpath -m "$TMP")"; fi

echo "==> Packing Websidian (src, public, package.json, package-lock.json, node_modules)"
tar -cf "$TMP/app.tar" src public package.json package-lock.json node_modules

echo "==> Packing the plugin (without tests, __pycache__ and deploy)"
tar -cf "$TMP/plugin.tar" --exclude=tests --exclude=__pycache__ --exclude=deploy -C integrations/hermes websidian

echo "==> Copying Websidian into $CONTAINER:$APP_DIR"
docker cp "$HOST_TMP/app.tar" "$CONTAINER:/tmp/websidian-app.tar"
# Replace code directories so deleted files do not linger; keep anything else in app_dir.
docker exec "$CONTAINER" sh -c "set -e; mkdir -p '$APP_DIR'; rm -rf '$APP_DIR/src' '$APP_DIR/public' '$APP_DIR/node_modules'; \
  tar -xf /tmp/websidian-app.tar -C '$APP_DIR'; rm -f /tmp/websidian-app.tar"

echo "==> Copying the plugin into $CONTAINER:$PLUGIN_DIR"
docker cp "$HOST_TMP/plugin.tar" "$CONTAINER:/tmp/websidian-plugin.tar"
PARENT="$(dirname "$PLUGIN_DIR")"
docker exec "$CONTAINER" sh -c "set -e; mkdir -p '$PARENT/.websidian-install'; \
  tar -xf /tmp/websidian-plugin.tar -C '$PARENT/.websidian-install'; rm -f /tmp/websidian-plugin.tar; \
  rm -rf '$PLUGIN_DIR'; mv '$PARENT/.websidian-install/websidian' '$PLUGIN_DIR'; rmdir '$PARENT/.websidian-install'"

echo "==> Checking"
docker exec "$CONTAINER" sh -c "node --version; test -f '$APP_DIR/src/server.js' && echo 'app: ok'; \
  test -f '$PLUGIN_DIR/dashboard/manifest.json' && echo 'plugin: ok'"

cat <<EOF

Done. Nothing was restarted and config.yaml was not changed.

Next steps (inside the container, e.g. docker exec -it $CONTAINER bash):

  1. Make sure the plugin is enabled (it already is if 'websidian' is listed under plugins.enabled):
       hermes plugins enable websidian

  2. Configure the dashboard tab and the vaults ('hermes' is /root/.local/bin/hermes if it is
     not on PATH; 'config set' accepts JSON/YAML literals for lists and writes only these keys):
       hermes config set plugins.entries.websidian.settings.dashboard '{"port": 8095, "app_dir": "$APP_DIR", "node": "node", "public_base": "http://localhost:9119"}'
       hermes config set plugins.entries.websidian.settings.link_style dashboard
       hermes config set plugins.entries.websidian.settings.vaults '[{"path": "/root/Documents/Obsidian Vault", "slug": "brain", "title": "Second Brain"}, {"path": "/root/.hermes/memories", "slug": "memories", "title": "Memories", "edit": false}]'
     (every vault is untrusted unless you set "untrusted": false, which you should not; "edit" defaults to true.)
     Replace the vaults list with your own; the test vault currently configured is dropped by this command.

  3. Restart the dashboard (plugin API routes are mounted only at dashboard start-up) and the gateway (so the
     agent plugin picks up link_style). Then open http://localhost:9119/websidian.

  Logs and generated files: /root/.hermes/plugin-data/websidian/{server.log,websidian.config.json,secrets.json}
EOF
