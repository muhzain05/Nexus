#!/bin/sh
# Regenerates mod/nexus/tests/golden/*.ts. Needs Node 18+ and network access for esbuild (fetched by npx).
set -eu
cd "$(dirname "$0")/../.."
tmp="$(mktemp -d)"
npx --yes esbuild@0.25.0 .github/scripts/goldens.ts --bundle --format=cjs --platform=node --outfile="$tmp/goldens.cjs" --log-level=error
node "$tmp/goldens.cjs" .
rm -rf "$tmp"
