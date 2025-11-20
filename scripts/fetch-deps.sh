#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
DEPS_DIR="$REPO_ROOT/deps"
mkdir -p "$DEPS_DIR"

PKGS=(
  nginx
  postgresql-16
  postgresql-client-16
  postgresql-common
  libpq5
  logrotate
  fail2ban
  gettext-base
  rsync
)

echo "📦 Fetching APT packages into $DEPS_DIR"
sudo apt-get update
sudo apt-get install --download-only \
  -o Dir::Cache::Archives="$DEPS_DIR" \
  -o APT::Architectures=$(dpkg --print-architecture) \
  "${PKGS[@]}"
rm -rf "$DEPS_DIR/partial"

NODE_VERSION="v20.17.0"
NODE_TARBALL="node-${NODE_VERSION}-linux-x64.tar.xz"
if [[ ! -f "$DEPS_DIR/$NODE_TARBALL" ]]; then
  echo "⬇️  Downloading Node.js ${NODE_VERSION}"
  curl -L "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}" -o "$DEPS_DIR/$NODE_TARBALL"
fi

if ! ls "$DEPS_DIR"/pm2-*.tgz >/dev/null 2>&1; then
  echo "⬇️  Packing PM2 for offline install"
  npm pack pm2 --pack-destination "$DEPS_DIR"
fi

echo "✅ Dependency artifacts downloaded to $DEPS_DIR"
