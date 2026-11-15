#!/usr/bin/env bash
# Point index.html at tracker.js by content hash, so browsers never mix a new page with a cached old engine.
# Run after changing docs/tracker.js (or any time; it is idempotent).
set -euo pipefail
cd "$(dirname "$0")/.."
h=$(sha256sum docs/tracker.js | cut -c1-10)
sed -i -E "s#<script src=\"tracker\.js(\?v=[0-9a-f]+)?\"></script>#<script src=\"tracker.js?v=${h}\"></script>#" docs/index.html
grep -q "tracker.js?v=${h}" docs/index.html && echo "index.html -> tracker.js?v=${h}"
