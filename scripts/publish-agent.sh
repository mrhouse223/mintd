#!/usr/bin/env bash
# Refresh money/agent-data.json and publish it, but ONLY that file.
#
#   ./scripts/publish-agent.sh
#
# The Agent tab in the app reads a committed JSON snapshot, so the live
# page is exactly as fresh as the last run of this script. Without it the page
# stops moving the moment the agent does something interesting.
#
# Same shape as publish-stats.sh, and narrow for the same reason: it stages one
# path, so an unfinished contract edit in the working tree can never be swept
# into an automated commit and pushed to the live site.
set -euo pipefail
cd "$(dirname "$0")/.."

# Checked before the indexer runs. A feature branch or detached HEAD means the
# push lands somewhere wrong, and there is no point spending a scan to find out.
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "on branch '$branch', not main: skipping publish"
  exit 0
fi

node scripts/agent-indexer.js

# Staged before comparing: `git diff` reports no change for an untracked path,
# so a working-tree comparison would exit "unchanged" forever on a new file.
git add money/agent-data.json
if git diff --cached --quiet -- money/agent-data.json; then
  echo "no agent activity since last run, nothing to publish"
  exit 0
fi

git commit -q -m "agent: refresh $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q origin main
echo "published $(node -e '
const d=require("./money/agent-data.json");
const vs=Object.values(d.vaults);
const rebs=vs.reduce((n,v)=>n+v.events.filter(e=>e.name==="Rebalanced").length,0);
console.log(vs.length+" vault(s), "+rebs+" rebalance(s), block "+d.lastScanned);
')"
