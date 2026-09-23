#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
    echo "Install Docker Desktop with Compose to validate this configuration." >&2
    exit 1
  fi
  VERSION=v5.4.0
  TOOLS="$PWD/.local/tools"
  BINARY="docker-compose-linux-x86_64"
  mkdir -p "$TOOLS"
  if [ ! -x "$TOOLS/compose-$VERSION" ]; then
    BASE="https://github.com/docker/compose/releases/download/$VERSION"
    curl --fail --silent --show-error --location "$BASE/$BINARY" -o "$TOOLS/$BINARY"
    curl --fail --silent --show-error --location "$BASE/$BINARY.sha256" -o "$TOOLS/$BINARY.sha256"
    (cd "$TOOLS"; sha256sum --check "$BINARY.sha256")
    mv "$TOOLS/$BINARY" "$TOOLS/compose-$VERSION"
    chmod 755 "$TOOLS/compose-$VERSION"
  fi
  COMPOSE=("$TOOLS/compose-$VERSION")
fi

"${COMPOSE[@]}" version
for mode in local demo; do
  POSTGRES_PASSWORD=configuration-validation-only APP_MODE="$mode" "${COMPOSE[@]}" config --quiet
  echo "Compose configuration ($mode): valid. No containers have been started."
done
