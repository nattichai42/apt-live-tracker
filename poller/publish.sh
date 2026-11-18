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
  const ev = Object.values(s.events || {});
  const players = new Set(); let bullets = 0;
  for (const e of ev) for (const [k, p] of Object.entries(e.p || {})) { players.add(k.replace(/ \(\d+\)$/, "")); bullets += p.b || 0; }
  let paid = 0; for (const r of Object.values(s.results || {})) for (const row of r.rows || []) paid += Number(row[3]) || 0;
  const live = ev.filter(e => e.polls && e.phase && e.phase !== "Completed" && !["Reg Open", "Scheduled", "Upcoming"].includes(e.phase));
  // Small summary for the home page banners
  const out = { updatedAt: s.updatedAt, events: ev.length, polled: ev.filter(e => e.polls).length, feed: (s.feed || []).length,
    running: live.length, finished: ev.filter(e => e.polls && e.phase === "Completed").length, players: players.size, bullets, paid,
    lastBust: ((s.feed || []).filter(f => f.k === "bust").pop() || {}).t || null };
  require("fs").writeFileSync(process.argv[2], JSON.stringify(out));
' "$TMP/state.json" "$TMP/meta.json"
cd "$TMP"
git init -q -b "$BRANCH"
git add state.json meta.json
git -c user.name="apt-tracker-bot" -c user.email="apt-tracker-bot@users.noreply.github.com" commit -qm "state $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"
echo "published $(wc -c < state.json) bytes to $BRANCH"
rm -rf "$TMP"
