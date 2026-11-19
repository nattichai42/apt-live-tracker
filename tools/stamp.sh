#!/usr/bin/env bash
# Point each page at its scripts by content hash, so browsers never mix a new page with a cached old engine.
# Run after changing any engine (docs/apt/tracker.js, docs/gop/gop.js, docs/rop/rop.js, docs/glpc/glpc.js, docs/triton/triton.js),
# docs/fx.js, docs/series.js, docs/people.js, docs/all/all.js or docs/apt/index.html (or any time; it is idempotent).
# It also makes docs/gop/index.html and docs/rop/index.html from the APT page: edit the APT page, never the copies.
set -euo pipefail
cd "$(dirname "$0")/.."
stamp() { # page, script src as the page writes it (relative to the page)
  local page="$1" src="$2" file h re
  file="$(dirname "$page")/$src"
  h=$(sha256sum "$file" | cut -c1-10)
  re=$(printf '%s' "$src" | sed 's/[.\/]/\\&/g')
  sed -i -E "s#<script src=\"${re}(\?v=[0-9a-f]+)?\"></script>#<script src=\"${src}?v=${h}\"></script>#" "$page"
  grep -q "${src}?v=${h}" "$page" && echo "$page -> ${src}?v=${h}"
}
stamp docs/apt/index.html tracker.js
# Gods of Poker and the Royal Poker Tour use the APT page (their engines give it the APT engine's state): each page is
# the APT page with data-org="<org>" and its engine after APT's
org_page() { # org, engine file, page title
  sed -e "s#^<html lang=\"en\">\$#<html lang=\"en\" data-org=\"$1\">#" \
      -e "s#^<title>[^<]*</title>\$#<title>$3</title>#" \
      -e "s#^<script src=\"tracker\\.js\\(?v=[0-9a-f]*\\)\\{0,1\\}\"></script>\$#<script src=\"../apt/tracker.js\"></script>\\
<script src=\"$2\"></script>#" \
      -e '2i<!-- Made by tools/stamp.sh from docs/apt/index.html: edit that page, not this one -->' \
      docs/apt/index.html
}
for o in "gop gop.js Gods of Poker Live Tracker" "rop rop.js Royal Poker Tour Live Tracker"; do
  set -- $o; org=$1 js=$2; shift 2
  mkdir -p "docs/$org"
  org_page "$org" "$js" "$*" > "docs/$org/index.html"
  stamp "docs/$org/index.html" ../apt/tracker.js
  stamp "docs/$org/index.html" "$js"
done
stamp docs/glpc/index.html glpc.js
stamp docs/triton/index.html triton.js
for page in docs/apt/index.html docs/gop/index.html docs/rop/index.html docs/glpc/index.html docs/triton/index.html docs/all/index.html; do stamp "$page" ../fx.js; stamp "$page" ../series.js; done
stamp docs/index.html series.js
# The all-series page uses every engine
stamp docs/all/index.html ../apt/tracker.js
stamp docs/all/index.html ../gop/gop.js
stamp docs/all/index.html ../rop/rop.js
stamp docs/all/index.html ../glpc/glpc.js
stamp docs/all/index.html ../triton/triton.js
stamp docs/all/index.html ../people.js
stamp docs/all/index.html all.js
