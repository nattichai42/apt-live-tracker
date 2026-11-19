#!/usr/bin/env bash
# Save a finished series in its organiser's archive and commit that to main (the "Poll series" workflow's last run).
#   poller/archive.sh <series id> <state.json>              the real thing
#   poller/archive.sh <series id> <state.json> --rehearse   everything the same, but the commit goes to a scratch branch
#                                                           that is deleted again, so main and the site don't change
# Works on today's main (others may have pushed during the run); a push that loses a race is retried.
# Needs GH_TOKEN (and push access through the checkout's credentials).
set -euo pipefail
SERIES="$1"; STATE="$2"; REHEARSE="${3:-}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}"
TARGET=main
[ "$REHEARSE" = --rehearse ] && TARGET="rehearse/archive-$SERIES"

git config user.name "apt-tracker-bot"
git config user.email "apt-tracker-bot@users.noreply.github.com"

pages() {
  # The site rebuilds from main by itself; asking as well covers a push that doesn't start a build
  local info
  info=$(gh api "repos/$GITHUB_REPOSITORY/pages" --jq '"source " + .source.branch + .source.path + ", build type " + .build_type' 2>&1) \
    && echo "Pages: $info" || echo "::warning::Could not read the Pages settings: $info"
  # (a rehearsal asks too: it only rebuilds the same site, and shows the request is allowed)
  gh api -X POST "repos/$GITHUB_REPOSITORY/pages/builds" --jq '"Asked for a site build: " + .status' 2>&1 \
    || { echo "::warning::Could not ask for a site build; the push itself should start one."; [ "$REHEARSE" != --rehearse ] || exit 1; }
}

for attempt in 1 2 3 4; do
  git fetch -q --depth=1 origin main && git reset -q --hard origin/main
  code=0; node poller/ctl.js archive "$SERIES" "$STATE" || code=$?
  [ "$code" = 3 ] && exit 0          # this organiser has no archive
  [ "$code" = 0 ] || exit "$code"
  git add docs
  if git diff --cached --quiet; then echo "Archive unchanged."; pages; exit 0; fi
  git diff --cached --stat | tail -5
  git commit -qm "Archive $SERIES (saved by its poller when it ended)"
  if git push -q origin "HEAD:refs/heads/$TARGET"; then
    if [ "$REHEARSE" = --rehearse ]; then
      [ "$(git ls-remote origin "refs/heads/$TARGET" | cut -f1)" = "$(git rev-parse HEAD)" ] \
        && echo "Rehearsal: the commit reached GitHub ($TARGET); main would take it the same way." \
        || { echo "::error::Rehearsal: the pushed branch isn't there"; exit 1; }
      git push -q origin --delete "$TARGET" && echo "Rehearsal: scratch branch deleted."
    else
      echo "Archived $SERIES to main."
    fi
    pages
    exit 0
  fi
  [ "$REHEARSE" = --rehearse ] && { echo "::error::Rehearsal: push refused"; exit 1; }
  sleep $((attempt * 15))
done
echo "::error::Could not push the archive of $SERIES"; exit 1
