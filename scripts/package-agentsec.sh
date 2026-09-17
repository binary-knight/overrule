#!/usr/bin/env bash
# Package the latest agentsec-pack source into vendor/ so the app can install it on a host without network access to GitHub.
# Usage: scripts/package-agentsec.sh [path-to-checkout]
# Without a path it clones the public repository at its default branch. If that repository is ever private, set
# AGENTSEC_PACK_TOKEN to a token with read access to it (the workflow passes the AGENTSEC_PACK_TOKEN secret through).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:-}"
OUT="vendor"
mkdir -p "$OUT"
cleanup=""
if [ -z "$SRC" ]; then
  tmp="$(mktemp -d)"; cleanup="$tmp"
  auth=()
  if [ -n "${AGENTSEC_PACK_TOKEN:-}" ]; then
    # Same shape actions/checkout uses; the token never appears in a URL or an error message.
    auth=(-c "http.https://github.com/.extraheader=Authorization: basic $(printf 'x-access-token:%s' "$AGENTSEC_PACK_TOKEN" | base64 -w0)")
  fi
  if ! GIT_TERMINAL_PROMPT=0 git "${auth[@]}" clone --quiet --depth 1 https://github.com/binary-knight/agentsec-pack.git "$tmp/agentsec-pack"; then
    echo "could not clone binary-knight/agentsec-pack. Check network access to github.com; if the repository is private, set AGENTSEC_PACK_TOKEN" >&2
    echo "to a token with read access to it (a fine-grained token with Contents: read), or pass a local checkout as the first argument." >&2
    exit 1
  fi
  SRC="$tmp/agentsec-pack"
fi
commit="$(git -C "$SRC" rev-parse HEAD)"
short="${commit:0:8}"
version="$(grep -m1 '^version' "$SRC/pyproject.toml" | sed 's/.*"\(.*\)".*/\1/')"
file="agentsec-pack-${version}-${short}.tar.gz"
rm -f "$OUT"/agentsec-pack-*.tar.gz
git -C "$SRC" archive --format=tar.gz --prefix=agentsec-pack/ -o "$PWD/$OUT/$file" HEAD
# Keep the packaging date when the commit is unchanged, so a daily run does not produce a new commit for a timestamp alone.
date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -f "$OUT/agentsec.json" ] && grep -q "\"commit\":\"$commit\"" "$OUT/agentsec.json"; then
  date="$(sed 's/.*"date":"\([^"]*\)".*/\1/' "$OUT/agentsec.json")"
fi
printf '{"version":"%s","commit":"%s","date":"%s","file":"%s","source":"https://github.com/binary-knight/agentsec-pack"}\n' "$version" "$commit" "$date" "$file" > "$OUT/agentsec.json"
[ -n "$cleanup" ] && rm -rf "$cleanup"
echo "packaged $file ($commit)"
