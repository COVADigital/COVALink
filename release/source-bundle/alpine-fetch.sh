#!/bin/sh
# Runs inside the pinned Alpine fetch image. Reads "origin commit version" lines
# on stdin and, for each origin, stores its aports recipe at that commit and
# every source the recipe lists, then checks them against the recipe.
# Output: /out/alpine/<origin>/{aports,distfiles}.
set -eu
apk add --no-cache abuild curl tar >/dev/null
# The bundle holds regular files only. abuild's src/ work folder (links into
# distfiles) is removed; a link inside the recipe is replaced by a copy of its
# target, which must be a file in the same recipe. The recipe archive is kept
# exactly as fetched.
normalize() {
  rm -rf "$1/aports/src"
  find "$1/aports" -type l | while read -r l; do
    t=$(readlink -f "$l")
    case "$t" in "$1/aports/"*) ;; *) echo "FAIL: $l points outside its recipe"; exit 1 ;; esac
    [ -f "$t" ] || { echo "FAIL: $l doesn't point at a file"; exit 1; }
    rm "$l" && cp "$t" "$l"
  done
  if [ -n "$(find "$1" ! -type f ! -type d)" ]; then echo "FAIL: $1 holds something other than files"; exit 1; fi
}
adduser -D fetch >/dev/null 2>&1 || true
addgroup fetch abuild >/dev/null 2>&1 || true
while read -r origin commit version; do
  d=/out/alpine/$origin
  mkdir -p "$d/aports" "$d/distfiles"
  archive="$d/aports-$commit-main-$origin.tar.gz"
  curl -fsSL "https://gitlab.alpinelinux.org/alpine/aports/-/archive/$commit/aports-$commit.tar.gz?path=main/$origin" -o "$archive"
  tar xzf "$archive" -C "$d/aports" --strip-components=3
  got=$(cd "$d/aports" && sh -c '. ./APKBUILD; echo "$pkgver-r$pkgrel"')
  if [ "$got" != "$version" ]; then echo "FAIL $origin: recipe version $got, image version $version"; exit 1; fi
  chown -R fetch "$d"
  if su fetch -c "cd '$d/aports' && SRCDEST='$d/distfiles' abuild fetch && SRCDEST='$d/distfiles' abuild verify" >/tmp/verify.log 2>&1; then
    echo "ok $origin $version: recipe at $commit, $(ls "$d/distfiles" | wc -l) upstream files match its sha512sums"
  else
    echo "FAIL $origin: sources don't match the recipe"; tail -5 /tmp/verify.log; exit 1
  fi
  normalize "$d"
done
chown -R 0:0 /out/alpine
