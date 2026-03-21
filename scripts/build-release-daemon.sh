#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/build-release-daemon.sh <output-path>

Builds a standalone universal exf-terminal-daemon binary for release packaging
and writes it to the supplied output path.
EOF
}

if [[ $# -ne 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  [[ $# -eq 1 ]] && exit 0
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_DIR="$ROOT_DIR/daemon"
OUTPUT_PATH="$1"
PKG_CACHE_DIR="${PKG_CACHE_PATH:-$HOME/.pkg-cache}"
PKG_RUNNER=(npx --yes @yao-pkg/pkg)

for tool in node npm npx uname; do
  command -v "$tool" >/dev/null || { echo "MISSING: $tool" >&2; exit 1; }
done

output_dir="$(dirname "$OUTPUT_PATH")"
output_base="$(basename "$OUTPUT_PATH")"
arm64_target="$output_dir/${output_base}-arm64"
x64_target="$output_dir/${output_base}-x64"

mkdir -p "$output_dir" "$PKG_CACHE_DIR"

echo "Building daemon TypeScript..."
(
  cd "$DAEMON_DIR"
  npm run build >/dev/null
)

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

arm64_out="$tmp_dir/exf-terminal-daemon-arm64"
x64_out="$tmp_dir/exf-terminal-daemon-x64"

echo "Packaging standalone daemon (arm64)..."
(
  cd "$DAEMON_DIR"
  PKG_CACHE_PATH="$PKG_CACHE_DIR" "${PKG_RUNNER[@]}" . --targets node18-macos-arm64 --output "$arm64_out" >/dev/null
)

echo "Packaging standalone daemon (x86_64)..."
(
  cd "$DAEMON_DIR"
  PKG_CACHE_PATH="$PKG_CACHE_DIR" "${PKG_RUNNER[@]}" . --targets node18-macos-x64 --output "$x64_out" >/dev/null
)

echo "Installing architecture-specific daemon binaries..."
cp "$arm64_out" "$arm64_target"
cp "$x64_out" "$x64_target"
chmod +x "$arm64_target" "$x64_target"

echo "Installing host-architecture daemon shim..."
case "$(uname -m)" in
  arm64|aarch64)
    cp "$arm64_out" "$OUTPUT_PATH"
    ;;
  x86_64)
    cp "$x64_out" "$OUTPUT_PATH"
    ;;
  *)
    echo "Unsupported build architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
chmod +x "$OUTPUT_PATH"

file "$arm64_target" >/dev/null
file "$x64_target" >/dev/null
echo "Built daemon launcher: $OUTPUT_PATH"
