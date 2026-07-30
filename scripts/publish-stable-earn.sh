#!/usr/bin/env bash
# Record StableEarn's share price and publish it, but ONLY that file.
#
#   ./scripts/publish-stable-earn.sh
#
# Modelled on publish-stats.sh and deliberately just as narrow: it stages exactly
# one path, so a half-finished edit sitting in the working tree can never be
# swept into an automated commit and pushed to the live site.
#
# The site reads frontend/stable-earn.json to state a measured yield. That number
# cannot be reconstructed later: Stable keeps no archive state, so a share price
# not captured while the chain was live is gone. This is the only record.
set -euo pipefail
cd "$(dirname "$0")/.."

# Checked before the read, not after. This repo now has a second worktree on the
# arcswap branch, so "which branch am I on" is a live question rather than a
# formality, and a push from the wrong one lands somewhere wrong.
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "on branch '$branch', not main: skipping publish"
  exit 0
fi

node scripts/stable-earn-snapshot.js

# Staged first, then compared against the index, for the same reason
# publish-stats.sh does it: git diff reports no change for an untracked path, so
# a working-tree comparison would exit "unchanged" forever and never ship.
git add frontend/stable-earn.json
if git diff --cached --quiet -- frontend/stable-earn.json; then
  echo "no new snapshot, nothing to publish"
  exit 0
fi

git commit -q -m "stable-earn: snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q origin main
echo "published $(node -e 'const d=require("./frontend/stable-earn.json");const s=d.snapshots;const f=s[0],l=s[s.length-1];const days=(l.ts-f.ts)/86400;console.log(s.length+" snapshots spanning "+days.toFixed(2)+"d")')"
