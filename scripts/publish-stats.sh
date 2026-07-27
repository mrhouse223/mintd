#!/usr/bin/env bash
# Refresh frontend/stats.json and publish it, but ONLY that file.
#
#   ./scripts/publish-stats.sh
#
# Safe to run on a timer. Deliberately narrow: it stages exactly one path, so a
# half-finished contract edit sitting in the working tree can never be swept
# into an automated commit and pushed to the live site.
#
# Exits quietly when the numbers have not moved, so a frequent schedule does not
# produce a wall of empty commits.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/stats-indexer.js

# nothing to do if the figures are unchanged
if git diff --quiet -- frontend/stats.json; then
  echo "stats unchanged, nothing to publish"
  exit 0
fi

# refuse to run mid-rebase or on a detached HEAD, where a push would be wrong
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "on branch '$branch', not main: skipping publish"
  exit 0
fi

git add frontend/stats.json
git commit -q -m "stats: refresh $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q origin main
echo "published $(node -e 'const s=require("./frontend/stats.json");console.log("TVL $"+Number(s.tvl).toFixed(0)+", all-time vol $"+Number(s.volumeAllTime).toFixed(0))')"
