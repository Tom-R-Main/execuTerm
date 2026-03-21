#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build_remote_daemon_release_assets.sh \
  --version <app-version> \
  --release-tag <tag> \
  --repo <owner/repo> \
  --output-dir <dir>

Builds executerm-remote-daemon release assets for the supported remote platforms and emits:
  executerm-remote-daemon-<goos>-<goarch>
  executerm-remote-daemon-checksums.txt
  executerm-remote-daemon-manifest.json
EOF
}

VERSION=""
RELEASE_TAG=""
REPO=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --release-tag)
      RELEASE_TAG="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$VERSION" || -z "$RELEASE_TAG" || -z "$REPO" || -z "$OUTPUT_DIR" ]]; then
  echo "error: --version, --release-tag, --repo, and --output-dir are required" >&2
  usage
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  echo "error: go is required to build executerm-remote-daemon release assets" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DAEMON_ROOT="${REPO_ROOT}/daemon/remote"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
rm -f "$OUTPUT_DIR"/executerm-remote-daemon-* "$OUTPUT_DIR"/executerm-remote-daemon-checksums.txt "$OUTPUT_DIR"/executerm-remote-daemon-manifest.json

DAEMON_GO_LDFLAGS="-s -w -X main.version=${VERSION}"
DAEMON_GO_BUILD_ARGS=(
  build
  -trimpath
  -buildvcs=false
  -ldflags "$DAEMON_GO_LDFLAGS"
)

CHECKSUMS_ASSET_NAME="executerm-remote-daemon-checksums.txt"
CHECKSUMS_PATH="${OUTPUT_DIR}/${CHECKSUMS_ASSET_NAME}"
MANIFEST_PATH="${OUTPUT_DIR}/executerm-remote-daemon-manifest.json"

TARGETS=(
  "darwin arm64"
  "darwin amd64"
  "linux arm64"
  "linux amd64"
)

: > "$CHECKSUMS_PATH"
ENTRIES_FILE="$(mktemp "${TMPDIR:-/tmp}/executerm-remote-daemon-entries.XXXXXX")"
trap 'rm -f "$ENTRIES_FILE"' EXIT
: > "$ENTRIES_FILE"

for target in "${TARGETS[@]}"; do
  read -r GOOS GOARCH <<<"$target"
  ASSET_NAME="executerm-remote-daemon-${GOOS}-${GOARCH}"
  OUTPUT_PATH="${OUTPUT_DIR}/${ASSET_NAME}"

  (
    cd "$DAEMON_ROOT"
    GOOS="$GOOS" \
    GOARCH="$GOARCH" \
    CGO_ENABLED=0 \
    go "${DAEMON_GO_BUILD_ARGS[@]}" \
      -o "$OUTPUT_PATH" \
      ./cmd/cmuxd-remote
  )
  chmod 755 "$OUTPUT_PATH"

  SHA256="$(shasum -a 256 "$OUTPUT_PATH" | awk '{print $1}')"
  printf '%s  %s\n' "$SHA256" "$ASSET_NAME" >> "$CHECKSUMS_PATH"

  printf '%s\t%s\t%s\t%s\n' "$GOOS" "$GOARCH" "$ASSET_NAME" "$SHA256" >> "$ENTRIES_FILE"
done

python3 - <<'PY' "$VERSION" "$RELEASE_TAG" "$REPO" "$CHECKSUMS_ASSET_NAME" "$CHECKSUMS_PATH" "$MANIFEST_PATH" "$ENTRIES_FILE"
import json
import sys
import urllib.parse
from pathlib import Path

version, release_tag, repo, checksums_asset_name, checksums_path, manifest_path, entries_file = sys.argv[1:]
quoted_tag = urllib.parse.quote(release_tag, safe="")
release_url = f"https://github.com/{repo}/releases/download/{quoted_tag}"
checksums_url = f"{release_url}/{urllib.parse.quote(checksums_asset_name, safe='')}"

entries = []
for line in Path(entries_file).read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    go_os, go_arch, asset_name, sha256 = line.split("\t")
    entries.append({
        "goOS": go_os,
        "goArch": go_arch,
        "assetName": asset_name,
        "downloadURL": f"{release_url}/{urllib.parse.quote(asset_name, safe='')}",
        "sha256": sha256,
    })

manifest = {
    "schemaVersion": 1,
    "appVersion": version,
    "releaseTag": release_tag,
    "releaseURL": release_url,
    "checksumsAssetName": checksums_asset_name,
    "checksumsURL": checksums_url,
    "entries": entries,
}
Path(manifest_path).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "Built executerm-remote-daemon assets in ${OUTPUT_DIR}"
