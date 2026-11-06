#!/bin/sh
# Writes snapshots of sample-data screens to <outdir>/<fixture>.jsonl. Needs Node 18+ and network access for esbuild
# (fetched by npx, pinned to the version update-goldens.sh uses). Render them with render.py still ... (no --pane).
#   .github/scripts/capture/samples.sh out/samples agent-failed telemetry-full
set -eu
cd "$(dirname "$0")/../../.."
out="$1"; shift
tmp="$(mktemp -d)"
npx --yes esbuild@0.25.0 .github/scripts/capture/samples.ts --bundle --format=cjs --platform=node --outfile="$tmp/samples.cjs" --log-level=error
node "$tmp/samples.cjs" "$out" "$@"
rm -rf "$tmp"
