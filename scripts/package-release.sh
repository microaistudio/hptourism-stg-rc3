#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

VERSION="${1:-r1.0.0}"
RELEASE_ROOT="${REPO_ROOT}/release"
TARGET_DIR="${RELEASE_ROOT}/homestay-${VERSION}"
ARCHIVE_NAME="homestay-${VERSION}.tar.gz"

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

echo "📦 Preparing homestay package ${VERSION}"

echo "🛠  Building production bundle"
npm run build >/dev/null

copy_tree() {
  local item="$1"
  if [[ -e "$item" ]]; then
    rsync -a "$item" "$TARGET_DIR/"
  fi
}

copy_tree client
copy_tree server
copy_tree shared
copy_tree dist
copy_tree node_modules
copy_tree deps
copy_tree Installation
copy_tree Database
copy_tree docs
copy_tree assets
copy_tree attached_assets
copy_tree scripts
copy_tree Documents
copy_tree migrations
copy_tree seed_data
copy_tree infra
copy_tree rest-express@1.0.0

files=(
  README.md
  app.json
  .env.example
  Installer.md
  drizzle.config.ts
  package.json
  package-lock.json
  ecosystem.config.cjs
  ecosystem.local.cjs
  tailwind.config.ts
  postcss.config.js
  tsconfig.json
  vite.config.ts
)

for file in "${files[@]}"; do
  if [[ -f "$file" ]]; then
    rsync -a "$file" "$TARGET_DIR/"
  fi
done

mkdir -p "$TARGET_DIR/local-object-storage"

mkdir -p "$RELEASE_ROOT"
ARCHIVE_PATH="${RELEASE_ROOT}/${ARCHIVE_NAME}"
rm -f "$ARCHIVE_PATH"

tar -czf "$ARCHIVE_PATH" -C "$RELEASE_ROOT" "homestay-${VERSION}"
basename_arch=$(basename "$ARCHIVE_PATH")
sha256sum "$ARCHIVE_PATH" | sed "s#  .*#  ${basename_arch}#" > "${ARCHIVE_PATH}.sha256"

echo "✅ Package ready: ${ARCHIVE_PATH}"
echo "   SHA256: $(cut -d' ' -f1 "${ARCHIVE_PATH}.sha256")"
