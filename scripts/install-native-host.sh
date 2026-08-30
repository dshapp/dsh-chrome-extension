#!/usr/bin/env bash
# Installs the DSH Chrome Bridge Native Messaging host manifest.
#
# Chrome only launches a native host whose manifest is registered at a
# well-known per-browser path, so the extension cannot install this for you
# at runtime — it must be run once by the browser's owner (like "Load
# unpacked" itself).
#
# Chrome launches GUI apps with a thin PATH that excludes /opt/homebrew/bin,
# so a #!/usr/bin/env node shebang fails to find node and the host exits
# immediately ("Native host has exited."). This script therefore writes a
# small wrapper that execs node at an absolute path, and points the manifest
# at the wrapper.
#
# Usage:
#   scripts/install-native-host.sh <extension-id>
#
# Find the extension id on chrome://extensions (turn on Developer mode).
set -euo pipefail

HOST_NAME="com.dsh.chrome"
EXTENSION_ID="${1:-${DSH_EXTENSION_ID:-}}"

if [[ -z "$EXTENSION_ID" ]]; then
  echo "usage: $0 <extension-id>" >&2
  echo "  find the id on chrome://extensions (Developer mode on)" >&2
  exit 2
fi

# Resolve the repo root from this script's location so paths are absolute.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_JS="$REPO_DIR/native-host/dsh-native-host.js"
WRAPPER="$REPO_DIR/native-host/dsh-native-host"

if [[ ! -f "$HOST_JS" ]]; then
  echo "host script not found at $HOST_JS" >&2
  exit 1
fi
chmod +x "$HOST_JS"

# Prefer stable symlink paths over versioned Cellar paths so the wrapper
# survives a node minor-version upgrade.
NODE_BIN=""
for candidate in "${NODE_BIN:-}" /opt/homebrew/bin/node /usr/local/bin/node; do
  [[ -n "$candidate" && -x "$candidate" ]] && NODE_BIN="$candidate" && break
done
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "node was not found; install Node or set NODE_BIN before running this" >&2
  exit 1
fi

# Write the wrapper that execs node at the absolute path. The manifest points
# at this wrapper, not at the .js file, so Chrome never depends on PATH.
# Native Messaging hosts receive no argv — Chrome talks over stdin only — so
# no "$@" passthrough is needed (and an unquoted here-doc would expand it).
cat > "$WRAPPER" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$HOST_JS"
EOF
chmod +x "$WRAPPER"

# Chrome user-level NativeMessagingHosts directory. Created if missing.
case "$(uname -s)" in
  Darwin)
    BASE_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    BASE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome/NativeMessagingHosts"
    ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
mkdir -p "$BASE_DIR"

MANIFEST="$BASE_DIR/$HOST_NAME.json"
cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "type": "stdio",
  "path": "$WRAPPER",
  "stdio": true,
  "description": "Starts the local DSH server (dsh web) on demand for the DSH Chrome Bridge extension.",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

echo "installed: $MANIFEST"
echo "  wrapper:   $WRAPPER"
echo "  host js:   $HOST_JS"
echo "  node:      $NODE_BIN"
echo "  allowed origin: chrome-extension://$EXTENSION_ID/"
echo "reload the extension on chrome://extensions to pick up the new nativeMessaging permission."
