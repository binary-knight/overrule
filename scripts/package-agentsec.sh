#!/usr/bin/env bash
# Package the latest agentsec-pack source into vendor/ so the app can install it on a host without network access to GitHub.
# Usage: scripts/package-agentsec.sh [path-to-checkout]   (without a path, clones the public repository at its default branch)
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:-}"
OUT="vendor"
mkdir -p "$OUT"
cleanup=""
if [ -z "$SRC" ]; then
  tmp="$(mktemp -d)"; cleanup="$tmp"
  git clone --quiet --depth 1 https://github.com/binary-knight/agentsec-pack.git "$tmp/agentsec-pack"
  SRC="$tmp/agentsec-pack"
fi
commit="$(git -C "$SRC" rev-parse HEAD)"
short="${commit:0:8}"
version="$(grep -m1 '^version' "$SRC/pyproject.toml" | sed 's/.*"\(.*\)".*/\1/')"
file="agentsec-pack-${version}-${short}.tar.gz"
rm -f "$OUT"/agentsec-pack-*.tar.gz
git -C "$SRC" archive --format=tar.gz --prefix=agentsec-pack/ -o "$PWD/$OUT/$file" HEAD
printf '{"version":"%s","commit":"%s","date":"%s","file":"%s","source":"https://github.com/binary-knight/agentsec-pack"}\n' "$version" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$file" > "$OUT/agentsec.json"
[ -n "$cleanup" ] && rm -rf "$cleanup"
echo "packaged $file ($commit)"
