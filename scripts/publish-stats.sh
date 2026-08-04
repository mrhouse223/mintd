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

# Checked before the indexer runs, not after: a detached HEAD or a feature
# branch means the push would land somewhere wrong, and there is no reason to
# spend a full pool scan discovering that.
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "on branch '$branch', not main: skipping publish"
  exit 0
fi

node scripts/stats-indexer.js

# Staged first, then compared against the index. `git diff` reports no change
# for an untracked path, so while stats.json is untracked a working-tree
# comparison exits "unchanged" on every run and the file never ships.
# stats.json plus agent-trades.json (the keeper appends to it between runs; this
# is what carries it to the live site). Both staged narrowly, nothing else.
git add frontend/stats.json frontend/agent-trades.json 2>/dev/null || git add frontend/stats.json
if git diff --cached --quiet -- frontend/stats.json frontend/agent-trades.json; then
  echo "stats and trades unchanged, nothing to publish"
  exit 0
fi

git commit -q -m "stats: refresh $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q origin main
echo "published $(node -e 'const s=require("./frontend/stats.json");console.log("TVL $"+Number(s.tvl).toFixed(0)+", all-time vol $"+Number(s.volumeAllTime).toFixed(0))')"
