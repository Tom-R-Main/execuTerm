#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/dmg_layout.sh"

# Build, sign, notarize, create DMG, generate appcast, and upload to GitHub release.
# Usage: ./scripts/publish-release.sh <tag> [--allow-overwrite]
# Requires: source ~/.secrets/cmuxterm.env && export SPARKLE_PRIVATE_KEY

usage() {
  cat <<'EOF'
Usage: ./scripts/publish-release.sh <tag> [--allow-overwrite]

Options:
  --allow-overwrite   Permit replacing existing release assets for the same tag.
                      Use only for emergency rerolls.
EOF
}

ALLOW_OVERWRITE="false"
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-overwrite)
      ALLOW_OVERWRITE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done
set -- "${POSITIONAL[@]}"

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

TAG="$1"
SIGN_IDENTITY_NAME="Developer ID Application: Thomas Main (362U48T87P)"
APP_ENTITLEMENTS="execuTermRelease.entitlements"
APP_PATH="build/Build/Products/Release/execuTerm.app"
DAEMON_PATH="$APP_PATH/Contents/Resources/bin/exf-terminal-daemon"
DMG_NAME="execuTerm-macos.dmg"
APPCAST_NAME="executerm-appcast.xml"
RELEASE_REPO="Tom-R-Main/execuTerm"
STABLE_FEED_URL="https://github.com/${RELEASE_REPO}/releases/latest/download/${APPCAST_NAME}"

source ~/.secrets/cmuxterm.env
export SPARKLE_PRIVATE_KEY
for tool in zig xcodebuild hdiutil xcrun codesign ditto gh; do
  command -v "$tool" >/dev/null || { echo "MISSING: $tool" >&2; exit 1; }
done

SIGN_HASH="$(security find-identity -v -p codesigning | awk -v name="$SIGN_IDENTITY_NAME" 'index($0, name) {print $2; exit}')"
if [[ -z "$SIGN_HASH" ]]; then
  echo "No valid codesigning identity found for: $SIGN_IDENTITY_NAME" >&2
  exit 1
fi

create_release_dmg() {
  local dmg_path="$1"
  local app_bundle="$2"
  local sign_hash="$3"

  require_pinned_create_dmg
  create_styled_dmg "$dmg_path" "$app_bundle" "$sign_hash"
}

DAEMON_ENTITLEMENTS="daemon.entitlements"

sign_runtime_code() {
  local path="$1"
  local basename
  basename="$(basename "$path")"

  # Node.js standalone daemon binaries need JIT/memory entitlements
  if [[ "$basename" == exf-terminal-daemon* ]]; then
    /usr/bin/codesign --force --options runtime --timestamp --sign "$SIGN_HASH" --entitlements "$DAEMON_ENTITLEMENTS" "$path"
  else
    /usr/bin/codesign --force --options runtime --timestamp --sign "$SIGN_HASH" "$path"
  fi
}

if [[ ! -d "GhosttyKit.xcframework" ]]; then
  echo "Building GhosttyKit..."
  (
    cd ghostty
    zig build -Demit-xcframework=true -Demit-macos-app=false -Dxcframework-target=universal -Doptimize=ReleaseFast
  )
  rm -rf GhosttyKit.xcframework
  cp -R ghostty/macos/GhosttyKit.xcframework GhosttyKit.xcframework
else
  echo "GhosttyKit.xcframework exists, skipping build"
fi

echo "Building app..."
rm -rf build/
xcodebuild -scheme cmux -configuration Release -derivedDataPath build CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -5
echo "Build succeeded"

HELPER_PATH="$APP_PATH/Contents/Resources/bin/ghostty"
if [[ ! -x "$HELPER_PATH" ]]; then
  echo "Ghostty theme picker helper not found at $HELPER_PATH" >&2
  exit 1
fi

echo "Bundling release daemon..."
./scripts/build-release-daemon.sh "$DAEMON_PATH"

./scripts/validate_release_asset.sh app "$APP_PATH"

echo "Injecting Sparkle keys..."
SPARKLE_PUBLIC_KEY_DERIVED=$(swift scripts/derive_sparkle_public_key.swift "$SPARKLE_PRIVATE_KEY")
APP_PLIST="$APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :SUPublicEDKey" "$APP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :SUFeedURL" "$APP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $SPARKLE_PUBLIC_KEY_DERIVED" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :SUFeedURL string ${STABLE_FEED_URL}" "$APP_PLIST"

echo "Codesigning..."
while IFS= read -r binary_path; do
  sign_runtime_code "$binary_path"
done < <(find "$APP_PATH/Contents/Resources/bin" -maxdepth 1 -type f -perm -111 -print 2>/dev/null | sort)

while IFS= read -r framework_binary; do
  sign_runtime_code "$framework_binary"
done < <(find "$APP_PATH/Contents/Frameworks" -type f -perm -111 -print 2>/dev/null | sort)

while IFS= read -r nested_path; do
  sign_runtime_code "$nested_path"
done < <(
  find "$APP_PATH/Contents/Frameworks" \
    \( -name '*.xpc' -o -name '*.app' -o -name '*.framework' \) \
    -print 2>/dev/null | awk '{ print length($0) " " $0 }' | sort -rn | cut -d' ' -f2-
)

/usr/bin/codesign --force --options runtime --timestamp --sign "$SIGN_HASH" --entitlements "$APP_ENTITLEMENTS" "$APP_PATH"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
./scripts/validate_release_asset.sh app "$APP_PATH" --require-signature

echo "Notarizing app..."
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" executerm-notary.zip
xcrun notarytool submit executerm-notary.zip \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"
./scripts/validate_release_asset.sh app "$APP_PATH" --require-signature --require-gatekeeper
rm -f executerm-notary.zip

echo "Creating DMG..."
rm -f "$DMG_NAME"
create_release_dmg "$DMG_NAME" "$APP_PATH" "$SIGN_HASH"
./scripts/validate_release_asset.sh dmg "$DMG_NAME" --require-signature --require-styled
echo "Notarizing DMG..."
xcrun notarytool submit "$DMG_NAME" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
xcrun stapler staple "$DMG_NAME"
xcrun stapler validate "$DMG_NAME"
./scripts/validate_release_asset.sh dmg "$DMG_NAME" --require-signature --require-gatekeeper --require-styled

echo "Generating appcast..."
./scripts/sparkle_generate_appcast.sh "$DMG_NAME" "$TAG" "$APPCAST_NAME"

if gh release view "$TAG" --repo "$RELEASE_REPO" >/dev/null 2>&1; then
  echo "Release $TAG already exists"
  EXISTING_ASSETS="$(gh release view "$TAG" --repo "$RELEASE_REPO" --json assets --jq '.assets[].name' || true)"
  HAS_CONFLICTING_ASSET="false"
  for asset in "$DMG_NAME" "$APPCAST_NAME"; do
    if printf '%s\n' "$EXISTING_ASSETS" | grep -Fxq "$asset"; then
      HAS_CONFLICTING_ASSET="true"
      break
    fi
  done

  if [[ "$HAS_CONFLICTING_ASSET" == "true" && "$ALLOW_OVERWRITE" != "true" ]]; then
    echo "ERROR: Refusing to overwrite signed release assets for existing tag $TAG." >&2
    echo "Use a new tag, or rerun with --allow-overwrite for an emergency reroll." >&2
    exit 1
  fi

  if [[ "$ALLOW_OVERWRITE" == "true" ]]; then
    gh release upload "$TAG" "$DMG_NAME" "$APPCAST_NAME" --repo "$RELEASE_REPO" --clobber
  else
    gh release upload "$TAG" "$DMG_NAME" "$APPCAST_NAME" --repo "$RELEASE_REPO"
  fi
else
  gh release create "$TAG" "$DMG_NAME" "$APPCAST_NAME" --repo "$RELEASE_REPO" --title "$TAG" --notes "See CHANGELOG.md for details"
fi

gh release view "$TAG" --repo "$RELEASE_REPO"

rm -rf build/ "$DMG_NAME" "$APPCAST_NAME"
echo ""
echo "=== Release $TAG complete ==="
say "execuTerm release complete"
