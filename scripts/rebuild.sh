#!/bin/bash
# Rebuild and restart execuTerm

set -e

cd "$(dirname "$0")/.."

# Kill existing app if running
pkill -9 -f "executerm" 2>/dev/null || true
pkill -9 -f "cmux" 2>/dev/null || true

# Build
swift build

# Copy to app bundle
cp .build/debug/execuTerm .build/debug/execuTerm.app/Contents/MacOS/

# Open the app
open .build/debug/execuTerm.app
