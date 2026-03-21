#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/validate_release_asset.sh app <path-to-app> [--require-signature] [--require-gatekeeper]
  ./scripts/validate_release_asset.sh dmg <path-to-dmg> [--require-signature] [--require-gatekeeper]

Validates that a release app bundle or DMG contains a launchable execuTerm.app.
EOF
}

if [[ $# -lt 2 ]]; then
  usage >&2
  exit 1
fi

ASSET_TYPE="$1"
ASSET_PATH="$2"
shift 2

REQUIRE_SIGNATURE="false"
REQUIRE_GATEKEEPER="false"
REQUIRE_STYLED="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-signature)
      REQUIRE_SIGNATURE="true"
      ;;
    --require-gatekeeper)
      REQUIRE_GATEKEEPER="true"
      ;;
    --require-styled)
      REQUIRE_STYLED="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

read_bundle_executable() {
  local app_path="$1"
  /usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$app_path/Contents/Info.plist"
}

resolve_bundled_daemon_path() {
  local app_path="$1"
  local daemon_path="$app_path/Contents/Resources/bin/exf-terminal-daemon"
  local daemon_arm64="$daemon_path-arm64"
  local daemon_x64="$daemon_path-x64"

  case "$(uname -m)" in
    arm64|aarch64)
      if [[ -x "$daemon_arm64" ]]; then
        printf '%s\n' "$daemon_arm64"
        return 0
      fi
      ;;
    x86_64)
      if [[ -x "$daemon_x64" ]]; then
        printf '%s\n' "$daemon_x64"
        return 0
      fi
      ;;
  esac

  printf '%s\n' "$daemon_path"
}

validate_daemon_runtime() {
  local daemon_path="$1"
  local temp_dir
  temp_dir="$(mktemp -d)"
  local fake_socket="$temp_dir/nonexistent.sock"
  local output_file="$temp_dir/daemon-check.log"

  set +e
  "$daemon_path" --socket "$fake_socket" >"$output_file" 2>&1
  local exit_code=$?
  set -e

  if ! grep -Eq 'Socket connection attempt|Could not connect to socket after' "$output_file"; then
    echo "Bundled daemon failed runtime smoke test: $daemon_path" >&2
    cat "$output_file" >&2
    rm -rf "$temp_dir"
    exit 1
  fi

  rm -rf "$temp_dir"
  return 0
}

validate_app() {
  local app_path="$1"

  [[ -d "$app_path" ]] || { echo "Missing app bundle: $app_path" >&2; exit 1; }
  [[ -f "$app_path/Contents/Info.plist" ]] || { echo "Missing Info.plist in $app_path" >&2; exit 1; }

  local executable_name
  executable_name="$(read_bundle_executable "$app_path")"
  [[ -n "$executable_name" ]] || { echo "CFBundleExecutable missing in $app_path" >&2; exit 1; }

  local executable_path="$app_path/Contents/MacOS/$executable_name"
  [[ -f "$executable_path" ]] || { echo "App executable missing: $executable_path" >&2; exit 1; }
  [[ -x "$executable_path" ]] || { echo "App executable is not executable: $executable_path" >&2; exit 1; }

  local daemon_path="$app_path/Contents/Resources/bin/exf-terminal-daemon"
  local daemon_arm64="$daemon_path-arm64"
  local daemon_x64="$daemon_path-x64"
  [[ -f "$daemon_path" ]] || { echo "Bundled daemon missing: $daemon_path" >&2; exit 1; }
  [[ -x "$daemon_path" ]] || { echo "Bundled daemon is not executable: $daemon_path" >&2; exit 1; }
  [[ -f "$daemon_arm64" ]] || { echo "Bundled arm64 daemon missing: $daemon_arm64" >&2; exit 1; }
  [[ -x "$daemon_arm64" ]] || { echo "Bundled arm64 daemon is not executable: $daemon_arm64" >&2; exit 1; }
  [[ -f "$daemon_x64" ]] || { echo "Bundled x86_64 daemon missing: $daemon_x64" >&2; exit 1; }
  [[ -x "$daemon_x64" ]] || { echo "Bundled x86_64 daemon is not executable: $daemon_x64" >&2; exit 1; }

  local runtime_daemon_path
  runtime_daemon_path="$(resolve_bundled_daemon_path "$app_path")"
  [[ -x "$runtime_daemon_path" ]] || { echo "Resolved runtime daemon is not executable: $runtime_daemon_path" >&2; exit 1; }
  validate_daemon_runtime "$runtime_daemon_path"

  if [[ "$REQUIRE_SIGNATURE" == "true" ]]; then
    /usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"
  fi

  if [[ "$REQUIRE_GATEKEEPER" == "true" ]]; then
    /usr/sbin/spctl -a -vv "$app_path"
  fi
}

validate_dmg() {
  local dmg_path="$1"
  [[ -f "$dmg_path" ]] || { echo "Missing DMG: $dmg_path" >&2; exit 1; }

  local attach_output
  local volume_path=""

  attach_output="$(hdiutil attach "$dmg_path" -nobrowse -readonly)"
  while IFS= read -r line; do
    if [[ "$line" == *"/Volumes/"* ]]; then
      volume_path="${line##*$'\t'}"
    fi
  done <<< "$attach_output"

  if [[ -z "$volume_path" ]]; then
    echo "Could not determine mounted DMG volume for $dmg_path" >&2
    exit 1
  fi

  trap 'hdiutil detach "$volume_path" >/dev/null 2>&1 || true' EXIT

  local app_path="$volume_path/execuTerm.app"
  validate_app "$app_path"

  # Accept either a symlink or a Finder alias to /Applications
  if [[ ! -L "$volume_path/Applications" && ! -f "$volume_path/Applications" ]]; then
    echo "DMG is missing Applications link (symlink or alias): $dmg_path" >&2
    exit 1
  fi

  if [[ "$REQUIRE_STYLED" == "true" ]]; then
    if [[ ! -f "$volume_path/.background/execuTerm-dmg-background.tiff" && ! -f "$volume_path/.background/execuTerm-dmg-background.png" ]]; then
      echo "DMG is missing the styled background asset: $dmg_path" >&2
      exit 1
    fi

    if [[ ! -f "$volume_path/.DS_Store" ]]; then
      echo "DMG is missing Finder layout metadata (.DS_Store): $dmg_path" >&2
      exit 1
    fi
  fi

  hdiutil detach "$volume_path" >/dev/null
  trap - EXIT
}

case "$ASSET_TYPE" in
  app)
    validate_app "$ASSET_PATH"
    ;;
  dmg)
    validate_dmg "$ASSET_PATH"
    ;;
  *)
    echo "Unknown asset type: $ASSET_TYPE" >&2
    usage >&2
    exit 1
    ;;
esac

echo "Validated $ASSET_TYPE: $ASSET_PATH"
