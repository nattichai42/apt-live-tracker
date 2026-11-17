#!/usr/bin/env bash
# Publish state.json as a single commit on a data branch (force-pushed, so history stays small).
# Usage: publish.sh <state.json> [branch, default "data"]
set -euo pipefail
STATE="${1:-state/state.json}"
BRANCH="${2:-data}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN not set}"
TMP="$(mktemp -d)"
cp "$STATE" "$TMP/state.json"
node -e '
  const s = require(process.argv[1]);
  const out = { updatedAt: s.updatedAt, events: Object.keys(s.events).length, polled: Object.values(s.events).filter(e => e.polls).length, feed: s.feed.length };
  require("fs").writeFileSync(process.argv[2], JSON.stringify(out));
' "$TMP/state.json" "$TMP/meta.json"
cd "$TMP"
git init -q -b "$BRANCH"
git add state.json meta.json
git -c user.name="apt-tracker-bot" -c user.email="apt-tracker-bot@users.noreply.github.com" commit -qm "state $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"
echo "published $(wc -c < state.json) bytes to $BRANCH"
rm -rf "$TMP"
