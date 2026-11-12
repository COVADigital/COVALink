#!/usr/bin/env bash
# Builds web/Dockerfile's "patched-base" stage (the pinned NODE_IMAGE with the
# temporary Alpine zlib update) as a local image, confirms its installed zlib is
# exactly ALPINE_ZLIB_VERSION (release/config.env), and prints the image tag.
# The source bundle and the third-party notices read the image's package database
# from it, so they describe exactly what the COVALink image builds and runs on.
#
#   tag=$(bash release/patched-base.sh)
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$HERE/config.env"
[[ "${ALPINE_ZLIB_VERSION:-}" =~ ^[0-9][0-9a-z.]*-r[0-9]+$ ]] || { echo "refused: ALPINE_ZLIB_VERSION is malformed" >&2; exit 1; }
tag=covalink-patched-base:local
(cd "$HERE/.." && docker buildx build --load --target patched-base -t "$tag" web) >&2
got=$(docker run --rm --network none --entrypoint awk "$tag" '/^P:zlib$/{f=1} f&&/^V:/{print substr($0,3); exit}' /lib/apk/db/installed)
[[ "$got" == "$ALPINE_ZLIB_VERSION" ]] || { echo "refused: the patched base has zlib ${got:-(none)}, not $ALPINE_ZLIB_VERSION" >&2; exit 1; }
echo "$tag"
