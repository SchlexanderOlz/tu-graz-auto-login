#!/usr/bin/env bash
# Builds dist/zweitschluessel-<version>.zip with a single top-level folder "zweitschluessel/",
# ready to unzip and "Load unpacked" in Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
out="dist/zweitschluessel-${version}.zip"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/zweitschluessel" dist
cp -r manifest.json src icons LICENSE README.md "$stage/zweitschluessel/"
# Fixed timestamps so the same source gives the same zip.
find "$stage" -exec touch -d '2026-01-01T00:00:00Z' {} +
rm -f "$out"
(cd "$stage" && zip -qrX "$OLDPWD/$out" zweitschluessel)
echo "$out"
