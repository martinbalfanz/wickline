#!/usr/bin/env bash
# Merge future upstream commits into a review branch, then test before pushing.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash local changes first (git status is not clean)." >&2
  exit 1
fi
if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream https://github.com/keptaduona/wickline.git
fi
git fetch upstream main
git switch main
git pull --ff-only origin main
upstream_sha="$(git rev-parse --short=10 upstream/main)"
branch="sync/upstream-$upstream_sha"
git switch -c "$branch"
if ! git merge --no-edit upstream/main; then
  echo "Upstream changed a modified integration point. Resolve conflicts, then run npm test." >&2
  echo "Branch: $branch (no changes have been pushed)." >&2
  exit 1
fi
npm test
git push -u origin "$branch"
echo "Sync tested and pushed: $branch"
echo "Review and merge this branch into main when ready (no force pushes required)."
