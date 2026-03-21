#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

PACKAGE_SCRIPT="$ROOT_DIR/scripts/package-release.sh"
PUBLISH_SCRIPT="$ROOT_DIR/scripts/publish-release.sh"
VALIDATE_SCRIPT="$ROOT_DIR/scripts/validate_release_asset.sh"

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq "$expected" "$file"; then
    echo "FAIL: expected to find '$expected' in $file" >&2
    exit 1
  fi
}

assert_contains "$PACKAGE_SCRIPT" './scripts/build-release-daemon.sh "$DAEMON_PATH"'
assert_contains "$PACKAGE_SCRIPT" './scripts/validate_release_asset.sh app "$APP_PATH"'
assert_contains "$PACKAGE_SCRIPT" './scripts/validate_release_asset.sh dmg "$OUTPUT_DIR/$DMG_NAME"'
assert_contains "$PACKAGE_SCRIPT" 'source "$(cd "$(dirname "$0")" && pwd)/dmg_layout.sh"'

assert_contains "$PUBLISH_SCRIPT" './scripts/build-release-daemon.sh "$DAEMON_PATH"'
assert_contains "$PUBLISH_SCRIPT" './scripts/validate_release_asset.sh app "$APP_PATH" --require-signature'
assert_contains "$PUBLISH_SCRIPT" './scripts/validate_release_asset.sh app "$APP_PATH" --require-signature --require-gatekeeper'
assert_contains "$PUBLISH_SCRIPT" './scripts/validate_release_asset.sh dmg "$DMG_NAME" --require-signature --require-styled'
assert_contains "$PUBLISH_SCRIPT" './scripts/validate_release_asset.sh dmg "$DMG_NAME" --require-signature --require-gatekeeper --require-styled'
assert_contains "$PUBLISH_SCRIPT" 'require_pinned_create_dmg'

assert_contains "$VALIDATE_SCRIPT" 'Bundled daemon missing'
assert_contains "$VALIDATE_SCRIPT" 'Bundled daemon is not executable'
assert_contains "$VALIDATE_SCRIPT" 'DMG is missing the styled background asset'
assert_contains "$VALIDATE_SCRIPT" 'DMG is missing Finder layout metadata (.DS_Store)'

echo "PASS: release scripts enforce app and DMG validation gates"
