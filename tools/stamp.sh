#!/usr/bin/env bash
# Point each page at its scripts by content hash, so browsers never mix a new page with a cached old engine.
# Run after changing any engine (docs/apt/tracker.js, docs/glpc/glpc.js, docs/triton/triton.js), docs/fx.js,
# docs/series.js, docs/people.js or docs/all/all.js (or any time; it is idempotent).
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
stamp docs/glpc/index.html glpc.js
stamp docs/triton/index.html triton.js
for page in docs/apt/index.html docs/glpc/index.html docs/triton/index.html docs/all/index.html; do stamp "$page" ../fx.js; stamp "$page" ../series.js; done
stamp docs/index.html series.js
# The all-series page uses every engine
stamp docs/all/index.html ../apt/tracker.js
stamp docs/all/index.html ../glpc/glpc.js
stamp docs/all/index.html ../triton/triton.js
stamp docs/all/index.html ../people.js
stamp docs/all/index.html all.js
