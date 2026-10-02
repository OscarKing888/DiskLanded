#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$script_dir"
if ! command -v node >/dev/null 2>&1; then
    echo "Error: install Node.js 22 or newer to use bump-version." >&2
    exit 1
fi
exec node scripts/bump-version.js "$@"
