#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ -n "$(git -C "$repo" status --porcelain --untracked-files=normal)" ]; then
  echo "refusing baseline release build from a dirty worktree" >&2
  exit 1
fi
commit=$(git -C "$repo" rev-parse --short=12 HEAD)
# `dist/` is compiler output and scripts/build.mjs deliberately replaces it.
# Release bundles must survive the ordinary build/check commands that are run
# immediately after packaging during acceptance.
output="${AVH_RELEASE_OUTPUT:-$repo/harness/release/linux-debian12}"
mkdir -p "$output"
docker build \
  --file "$repo/harness/packaging/linux/Dockerfile.debian12" \
  --build-arg "AVH_BUILD_COMMIT=$commit" \
  --output "type=local,dest=$output" \
  "$repo"
printf 'Debian 12 baseline artifacts: %s\n' "$output"
