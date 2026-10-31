#!/bin/bash
# Capture an offline mirror of the upstream virus.sucks Pluslife app, for the
# snapshot history on the unrelated `mirror` branch (issue #3).
#
# The file set is whatever the site's service worker precaches, so the mirror
# tracks upstream's own idea of "everything the app needs offline" instead of a
# list we maintain by hand. Upstream moved to Workbox in October 2026, so that
# list is now the {"revision","url"} manifest baked into /sw.js; before then it
# was a hand-written urlsToCache array. We read the manifest rather than
# crawling the page because the page is not self-contained: it pulls site CSS
# and icons by absolute path, and a crawl would both miss some and drag in the
# rest of the site.
#
# Each manifest entry's revision is the MD5 of that file, which gives us a free
# integrity check: if a file does not match, we either raced a deploy mid-
# capture or upstream changed how revisions are computed. Either way the
# snapshot is not trustworthy as a single release, so say so and exit non-zero,
# but leave the files behind to be inspected.
set -euo pipefail

BASE="https://virus.sucks"
OUT="${1:-}"

if [[ -z "$OUT" ]]; then
  echo "usage: $(basename "$0") <output-dir>" >&2
  echo "Writes <output-dir>/virus.sucks/ plus checksums.sha256." >&2
  exit 1
fi

ROOT="$OUT/virus.sucks"
mkdir -p "$ROOT"
cd "$ROOT"

fetch() { # url-path  dest-file
  mkdir -p "$(dirname "$2")"
  curl -sfS --compressed -o "$2" "$BASE$1"
}

fetch /sw.js sw.js

# The precache manifest, as "<md5> <url-path>" lines.
MANIFEST="$(grep -o -E '\{"revision":"[^"]*","url":"/[^"]+"\}' sw.js \
  | sed 's/{"revision":"//; s/","url":"/ /; s/"}$//' | sort -u -k2)"

if [[ -z "$MANIFEST" ]]; then
  echo "No Workbox precache manifest found in /sw.js." >&2
  echo "Upstream has changed its service worker again — re-read sw.js and" >&2
  echo "update the extraction above before trusting a snapshot." >&2
  exit 1
fi

# Map the served path to a file: a directory URL is served from index.html.
dest_for() { case "$1" in */) echo ".$1index.html" ;; *) echo ".$1" ;; esac; }

mismatched=0
while read -r revision url; do
  dest="$(dest_for "$url")"
  fetch "$url" "$dest"
  actual="$(md5 -q "$dest")"
  if [[ "$actual" == "$revision" ]]; then
    printf '  %-42s %9d bytes\n' "$url" "$(wc -c < "$dest")"
  else
    printf '  %-42s MISMATCH manifest=%s actual=%s\n' "$url" "$revision" "$actual"
    mismatched=$((mismatched + 1))
  fi
done <<< "$MANIFEST"

find . -type f | sort | while read -r f; do shasum -a 256 "$f"; done > ../checksums.sha256

# Recorded in MIRROR-INFO.txt and the commit message, so the snapshot names the
# release it came from. The footer wraps the version across lines, hence the
# newline squeeze before matching.
VERSION="$(tr '\n' ' ' < pluslife_app/index.html | tr -s '[:space:]' ' ' \
  | grep -o -E 'Version: [a-z]+ \([0-9a-f]+\)' | head -1 || true)"

echo
echo "Captured $(find . -type f | wc -l | tr -d ' ') files to $ROOT"
echo "App ${VERSION:-version not found in index.html footer — check the page footer}"

if (( mismatched > 0 )); then
  echo
  echo "$mismatched file(s) did not match the precache manifest, so this is not" >&2
  echo "a clean picture of one release. A deploy mid-capture is the likely" >&2
  echo "cause — re-run. Files are left in place for inspection." >&2
  exit 1
fi

echo
echo "Next: commit onto the 'mirror' branch, whose history is snapshots only"
echo "(no tooling), so each diff is upstream's change alone:"
echo "  git worktree add --detach /tmp/mirror-wt && git -C /tmp/mirror-wt checkout mirror"
echo "Copy virus.sucks/ and checksums.sha256 over, update MIRROR-INFO.txt"
echo "(captured date, app version, file set, what changed), then commit."
