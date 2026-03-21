#!/usr/bin/env bash
set -euo pipefail

readonly CREATE_DMG_REQUIRED_VERSION="1.2.3"
readonly DMG_VOLUME_NAME="execuTerm"
readonly DMG_BACKGROUND_FILE="execuTerm-dmg-background.tiff"
readonly DMG_WINDOW_POS_X=240
readonly DMG_WINDOW_POS_Y=140
readonly DMG_WINDOW_WIDTH=720
readonly DMG_WINDOW_HEIGHT=420
readonly DMG_TEXT_SIZE=14
readonly DMG_ICON_SIZE=136
readonly DMG_APP_ICON_X=180
readonly DMG_APP_ICON_Y=215
readonly DMG_DROP_LINK_X=540
readonly DMG_DROP_LINK_Y=215

readonly DMG_LAYOUT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DMG_BACKGROUND_PATH="$DMG_LAYOUT_SCRIPT_DIR/assets/dmg/$DMG_BACKGROUND_FILE"

create_dmg_version() {
  create-dmg --version | awk 'NR==1 { print $2 }'
}

has_pinned_create_dmg() {
  if ! command -v create-dmg >/dev/null 2>&1; then
    return 1
  fi

  [[ "$(create_dmg_version)" == "$CREATE_DMG_REQUIRED_VERSION" ]]
}

require_pinned_create_dmg() {
  if ! command -v create-dmg >/dev/null 2>&1; then
    echo "Missing create-dmg. Install create-dmg $CREATE_DMG_REQUIRED_VERSION to build the styled DMG." >&2
    exit 1
  fi

  local actual_version
  actual_version="$(create_dmg_version)"
  if [[ "$actual_version" != "$CREATE_DMG_REQUIRED_VERSION" ]]; then
    echo "create-dmg version mismatch. Expected $CREATE_DMG_REQUIRED_VERSION, found $actual_version." >&2
    echo "Install the pinned tool before publishing a public release." >&2
    exit 1
  fi

  [[ -f "$DMG_BACKGROUND_PATH" ]] || {
    echo "Missing DMG background asset: $DMG_BACKGROUND_PATH" >&2
    exit 1
  }
}

create_plain_dmg() {
  local dmg_path="$1"
  local app_bundle="$2"

  local staging_dir
  staging_dir="$(mktemp -d)"
  cp -R "$app_bundle" "$staging_dir/"
  ln -s /Applications "$staging_dir/Applications"
  hdiutil create -volname "$DMG_VOLUME_NAME" -srcfolder "$staging_dir" -ov -format UDZO "$dmg_path"
  rm -rf "$staging_dir"
}

create_styled_dmg() {
  local dmg_path="$1"
  local app_bundle="$2"
  local sign_hash="${3:-}"

  require_pinned_create_dmg

  local staging_dir
  staging_dir="$(mktemp -d)"
  cp -R "$app_bundle" "$staging_dir/"

  # Create a Finder alias to /Applications instead of a plain symlink.
  # Symlinks often render as generic dashed-outline icons in Finder;
  # Finder aliases carry their own icon data and always show the real
  # Applications folder icon.
  osascript -e "tell application \"Finder\" to make alias file to folder \"Applications\" of startup disk at POSIX file \"$staging_dir\"" || {
    echo "Warning: Finder alias creation failed, falling back to symlink" >&2
    ln -s /Applications "$staging_dir/Applications"
  }

  # Explicitly set the real /Applications folder icon on the alias.
  # Without this, Finder often renders aliases as generic dashed outlines.
  osascript - "$staging_dir/Applications" <<'APPLESCRIPT' || true
use framework "AppKit"
on run argv
    set aliasPath to item 1 of argv
    set ws to current application's NSWorkspace's sharedWorkspace()
    set appIcon to ws's iconForFile:"/Applications"
    ws's setIcon:appIcon forFile:aliasPath options:0
end run
APPLESCRIPT

  local args=(
    --volname "$DMG_VOLUME_NAME"
    --window-pos "$DMG_WINDOW_POS_X" "$DMG_WINDOW_POS_Y"
    --window-size "$DMG_WINDOW_WIDTH" "$DMG_WINDOW_HEIGHT"
    --background "$DMG_BACKGROUND_PATH"
    --text-size "$DMG_TEXT_SIZE"
    --icon-size "$DMG_ICON_SIZE"
    --icon "execuTerm.app" "$DMG_APP_ICON_X" "$DMG_APP_ICON_Y"
    --hide-extension "execuTerm.app"
    --icon "Applications" "$DMG_DROP_LINK_X" "$DMG_DROP_LINK_Y"
    --format UDZO
    --hdiutil-quiet
  )

  if [[ -f "$app_bundle/Contents/Resources/AppIcon.icns" ]]; then
    args+=(--volicon "$app_bundle/Contents/Resources/AppIcon.icns")
  fi

  if [[ -n "$sign_hash" ]]; then
    args+=(--codesign "$sign_hash")
  fi

  create-dmg "${args[@]}" "$dmg_path" "$staging_dir"
  rm -rf "$staging_dir"
}
