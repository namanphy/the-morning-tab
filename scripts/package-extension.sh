#!/usr/bin/env bash
# Package the built extension as dist/the-morning-tab-chrome.zip. The zip holds
# one folder, so unzipping gives a folder people can pick in "Load unpacked".
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
build="$root/apps/extension/.output/chrome-mv3"
name="the-morning-tab-chrome"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

if [ ! -f "$build/manifest.json" ]; then
  echo "No build at $build. Run: pnpm build" >&2
  exit 1
fi

cp -R "$build" "$stage/$name"
mkdir -p "$root/dist"
rm -f "$root/dist/$name.zip"
(cd "$stage" && zip -qr -X "$root/dist/$name.zip" "$name")
echo "dist/$name.zip"
