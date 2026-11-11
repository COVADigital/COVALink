#!/bin/sh
# Copied into the bundle's rebuild kit. Mounted in place of curl during an
# offline libvips rebuild, it serves only files recorded in the bundle's index,
# so the build can't silently use anything from outside the bundle.
idx=/bundle/sharp-libvips/sources/urls.tsv; url=; out=
for a in "$@"; do case "$a" in https://*|http://*) url=$a;; -O) out=1;; esac; done
f=$(awk -F'\t' -v u="$url" '$1==u{print $2}' "$idx")
[ -n "$f" ] || { echo "curl-from-bundle: URL not in bundle: $url" >&2; exit 22; }
echo "curl-from-bundle: $f" >&2
if [ -n "$out" ]; then cp "/bundle/sharp-libvips/sources/$f" "./$(basename "$url")"; else cat "/bundle/sharp-libvips/sources/$f"; fi
