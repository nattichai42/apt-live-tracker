#!/usr/bin/env bash
# Publish state.json as a single commit on the `data` branch (force-pushed, so history stays small).
set -euo pipefail
STATE="${1:-state/state.json}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN not set}"
TMP="$(mktemp -d)"
cp "$STATE" "$TMP/state.json"
node -e '
  const s = require(process.argv[1]);
  const T = require(process.argv[2]);
  const out = { updatedAt: s.updatedAt, events: Object.keys(s.events).length, polled: Object.values(s.events).filter(e => e.polls).length, feed: s.feed.length };
  require("fs").writeFileSync(process.argv[3], JSON.stringify(out));
' "$TMP/state.json" "$(cd "$(dirname "$0")/.." && pwd)/docs/tracker.js" "$TMP/meta.json"
cd "$TMP"
git init -q -b data
git add state.json meta.json
git -c user.name="apt-tracker-bot" -c user.email="apt-tracker-bot@users.noreply.github.com" commit -qm "state $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" data
echo "published $(wc -c < state.json) bytes"
rm -rf "$TMP"
