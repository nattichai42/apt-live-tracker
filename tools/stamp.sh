#!/usr/bin/env bash
# Point each page at its engine by content hash, so browsers never mix a new page with a cached old engine.
# Run after changing docs/apt/tracker.js, docs/glpc/glpc.js (or any time; it is idempotent).
set -euo pipefail
cd "$(dirname "$0")/.."
stamp() { # page engine-file
  local page="$1" js="$2" name h
  name=$(basename "$js")
  h=$(sha256sum "$js" | cut -c1-10)
  sed -i -E "s#<script src=\"${name//./\\.}(\?v=[0-9a-f]+)?\"></script>#<script src=\"${name}?v=${h}\"></script>#" "$page"
  grep -q "${name}?v=${h}" "$page" && echo "$page -> ${name}?v=${h}"
}
stamp docs/apt/index.html docs/apt/tracker.js
stamp docs/glpc/index.html docs/glpc/glpc.js
stamp docs/triton/index.html docs/triton/triton.js
