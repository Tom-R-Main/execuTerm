#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/dmg_layout.sh"

usage() {
  cat <<'EOF'
Usage: ./scripts/package-release.sh [output-dir]

Builds a clean unsigned Release execuTerm.app and packages it into a local DMG.
The resulting app bundle and DMG are written to the output directory.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

OUTPUT_DIR="${1:-dist/release}"
APP_NAME="execuTerm.app"
DMG_NAME="execuTerm-macos.dmg"
APP_PATH="build/Build/Products/Release/${APP_NAME}"
DAEMON_PATH="$APP_PATH/Contents/Resources/bin/exf-terminal-daemon"

for tool in zig xcodebuild hdiutil; do
  command -v "$tool" >/dev/null || { echo "MISSING: $tool" >&2; exit 1; }
done

DMG_STYLE_MODE="plain"

create_release_dmg() {
  local dmg_path="$1"
  local app_bundle="$2"

  if has_pinned_create_dmg; then
    create_styled_dmg "$dmg_path" "$app_bundle"
    DMG_STYLE_MODE="styled"
    return
  fi

  echo "WARNING: create-dmg $CREATE_DMG_REQUIRED_VERSION not found; falling back to a plain DMG." >&2
  create_plain_dmg "$dmg_path" "$app_bundle"
  DMG_STYLE_MODE="plain"
}

if [[ ! -d "GhosttyKit.xcframework" ]]; then
  echo "Building GhosttyKit..."
  (
    cd ghostty
    zig build -Demit-xcframework=true -Demit-macos-app=false -Dxcframework-target=universal -Doptimize=ReleaseFast
  )
  rm -rf GhosttyKit.xcframework
  cp -R ghostty/macos/GhosttyKit.xcframework GhosttyKit.xcframework
fi

echo "Building Release app..."
rm -rf build/
xcodebuild -scheme cmux -configuration Release -derivedDataPath build CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -5

if [[ ! -d "$APP_PATH" ]]; then
  echo "Release app not found at $APP_PATH" >&2
  exit 1
fi

echo "Bundling release daemon..."
./scripts/build-release-daemon.sh "$DAEMON_PATH"

./scripts/validate_release_asset.sh app "$APP_PATH"

mkdir -p "$OUTPUT_DIR"
rm -rf "$OUTPUT_DIR/$APP_NAME" "$OUTPUT_DIR/$DMG_NAME"
cp -R "$APP_PATH" "$OUTPUT_DIR/$APP_NAME"

echo "Creating local DMG..."
create_release_dmg "$OUTPUT_DIR/$DMG_NAME" "$OUTPUT_DIR/$APP_NAME"
if [[ "$DMG_STYLE_MODE" == "styled" ]]; then
  ./scripts/validate_release_asset.sh dmg "$OUTPUT_DIR/$DMG_NAME" --require-styled
else
  ./scripts/validate_release_asset.sh dmg "$OUTPUT_DIR/$DMG_NAME"
fi

echo ""
echo "Created:"
echo "  $OUTPUT_DIR/$APP_NAME"
echo "  $OUTPUT_DIR/$DMG_NAME"
