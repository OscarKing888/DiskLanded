#!/bin/bash
set -euo pipefail

# Resolve the project from this script, including paths containing spaces.
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_dir"

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Error: run build-mac.sh on macOS." >&2
    exit 1
fi
if ! command -v go >/dev/null 2>&1; then
    echo "Error: install Go (see go.mod for the required version) and add it to PATH." >&2
    exit 1
fi
if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find clang >/dev/null 2>&1; then
    echo "Error: install Xcode Command Line Tools with: xcode-select --install" >&2
    exit 1
fi

# Use the project's Wails version without requiring a global CLI installation.
wails_version="$(go list -m -f '{{.Version}}' github.com/wailsapp/wails/v2)"
if [[ -z "$wails_version" ]]; then
    echo "Error: unable to resolve the Wails version from go.mod." >&2
    exit 1
fi

echo "Building DiskLanded for macOS (Intel + Apple Silicon), Wails $wails_version..."
export CGO_ENABLED=1
go run "github.com/wailsapp/wails/v2/cmd/wails@$wails_version" build \
    -skipbindings -trimpath -m -nosyncgomod -platform darwin/universal

echo "Built: $project_dir/build/bin/DiskLanded.app"
