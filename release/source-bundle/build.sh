#!/usr/bin/env bash
# Builds the COVALink source bundle from the pinned inputs in release/config.env.
#
#   release/source-bundle/build.sh <work dir>
#
# Needs bash, curl, node and Docker, with network access. Writes:
#   <work dir>/bundle/         the bundle tree, with MANIFEST.json, SHA256SUMS,
#                              README.md, alpine/, sharp-libvips/ and rebuild-kit/
#   <work dir>/origins.tsv     the base image's Alpine source packages
# Stages that finished are skipped on a rerun, so a failed step can be resumed.
# The bundle is packed and pushed by the candidate workflow (pack.Dockerfile).
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$HERE/../config.env"
WORK=${1:?usage: build.sh <work dir>}
mkdir -p "$WORK"
B="$WORK/bundle"
mkdir -p "$B"
done_stage() { [ -f "$WORK/.stage-$1" ]; }
mark() { touch "$WORK/.stage-$1"; echo "== stage $1 done"; }

# 1. The installed packages of the image's patched base (NODE_IMAGE plus the
#    temporary Alpine security update; release/patched-base.sh), grouped by Alpine
#    source package.
if ! done_stage origins; then
  base=$(bash "$HERE/../patched-base.sh")
  docker run --rm --network none --entrypoint cat "$base" /lib/apk/db/installed > "$WORK/installed"
  awk -F: '
    /^P:/ {p=$2} /^V:/ {v=$2} /^L:/ {l=$2} /^o:/ {o=$2} /^c:/ {c=$2}
    /^$/ { if (p != "") { key=o; com[key]=c; split(v, a, "-r"); ver[key]=v; pk[key]=pk[key] (pk[key] ? "," : "") p "|" v "|" l } p="" }
    END { for (k in pk) print k "\t" com[k] "\t" ver[k] "\t" pk[k] }' "$WORK/installed" | sort > "$WORK/origins.tsv"
  echo "base image source packages: $(wc -l < "$WORK/origins.tsv")"
  mark origins
fi

# 2. Alpine recipes and upstream sources, checked against each recipe.
if ! done_stage alpine; then
  rm -rf "$B/alpine"
  cut -f1-3 "$WORK/origins.tsv" | docker run --rm -i -v "$B:/out" -v "$HERE:/tools:ro" "$ALPINE_FETCH_IMAGE" sh /tools/alpine-fetch.sh
  mark alpine
fi

# 3. sharp-libvips build scripts at the pinned commit, and every file they download.
SL="$B/sharp-libvips"
if ! done_stage sharp-libvips; then
  rm -rf "$SL" "$WORK/sharp-libvips-src"
  mkdir -p "$SL/sources" "$WORK/sharp-libvips-src"
  archive="$SL/sharp-libvips-$SHARP_LIBVIPS_COMMIT.tar.gz"
  curl -fsSL "https://github.com/lovell/sharp-libvips/archive/$SHARP_LIBVIPS_COMMIT.tar.gz" -o "$archive"
  (cd "$WORK" && tar -xzf "bundle/sharp-libvips/sharp-libvips-$SHARP_LIBVIPS_COMMIT.tar.gz" -C sharp-libvips-src --strip-components=1)
  got=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$WORK/sharp-libvips-src/npm/linuxmusl-x64/package.json" | head -1)
  [ "$got" = "$SHARP_LIBVIPS_VERSION" ] || { echo "FAIL: sharp-libvips at $SHARP_LIBVIPS_COMMIT is version $got, expected $SHARP_LIBVIPS_VERSION"; exit 1; }
  # Every URL build/posix.sh fetches, with its version variables expanded.
  (
    cd "$WORK/sharp-libvips-src"
    # shellcheck disable=SC1091
    . ./versions.properties
    without_patch() { echo "${1%.[[:digit:]]*}"; }
    without_prerelease() { echo "${1%-[[:alnum:]]*}"; }
    grep -E '^\s*\$CURL ' build/posix.sh | sed -E 's/^\s*\$CURL (-O )?//; s/ \|.*$//' | while read -r u; do eval "echo \"$u\""; done
  ) > "$WORK/sharp-libvips-urls.txt"
  : > "$SL/sources/urls.tsv"
  n=0
  while read -r url; do
    n=$((n + 1))
    file=$(printf '%02d-%s' "$n" "$(basename "${url%%\?*}")")
    curl -fsSL --retry 3 "$url" -o "$SL/sources/$file"
    printf '%s\t%s\t%s\n' "$url" "$file" "$(sha256sum < "$SL/sources/$file" | cut -c1-64)" >> "$SL/sources/urls.tsv"
  done < "$WORK/sharp-libvips-urls.txt"
  echo "sharp-libvips $SHARP_LIBVIPS_VERSION: $n source files"
  mark sharp-libvips
fi

# 4. The pinned build environment: upstream's Dockerfile with four pins applied.
KIT="$B/rebuild-kit"
if ! done_stage rebuild-kit; then
  rm -rf "$KIT"; mkdir -p "$KIT"
  cp "$WORK/sharp-libvips-src/platforms/linuxmusl-x64/"* "$KIT/"
  sed -i -e "s|^FROM alpine:3.20\$|FROM $LIBVIPS_BUILD_BASE|" \
    -e "s|--default-toolchain nightly \\\\|--default-toolchain $LIBVIPS_RUST_TOOLCHAIN \\\\|" \
    -e "s|cargo install cargo-c --locked \&\&|cargo install cargo-c --locked --version $LIBVIPS_CARGO_C_VERSION \&\&|" \
    -e "s|pipx install meson\$|pipx install meson==$LIBVIPS_MESON_VERSION|" "$KIT/Dockerfile"
  for pin in "FROM $LIBVIPS_BUILD_BASE" "--default-toolchain $LIBVIPS_RUST_TOOLCHAIN" "cargo-c --locked --version $LIBVIPS_CARGO_C_VERSION" "meson==$LIBVIPS_MESON_VERSION"; do
    grep -qF -- "$pin" "$KIT/Dockerfile" || { echo "FAIL: pin not applied to the build environment: $pin"; exit 1; }
  done
  cp "$HERE/curl-from-bundle.sh" "$KIT/"
  printf '[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "/bundle/sharp-libvips/cargo/vendor"\n\n[net]\noffline = true\n' > "$KIT/cargo-config.toml"
  mark rebuild-kit
fi

# 5. The Rust crates librsvg's build resolves, vendored in the build environment.
if ! done_stage cargo; then
  rm -rf "$SL/cargo"
  docker build -q -t "covalink-libvips-buildenv:$SHARP_LIBVIPS_VERSION" "$KIT" > /dev/null
  docker run --rm -v "$B:/bundle" -v "$HERE:/tools:ro" "covalink-libvips-buildenv:$SHARP_LIBVIPS_VERSION" sh /tools/cargo-vendor.sh
  mark cargo
fi

# 6. Records: MANIFEST.json, README.md, REBUILD.md, then SHA256SUMS over every file.
# In the pinned Node image, offline, so the records don't depend on the host's Node.
docker run --rm --network none -v "$B:/b" -v "$WORK:/work:ro" -v "$HERE/..:/release:ro" \
  --entrypoint node "$NODE_IMAGE" /release/source-bundle/manifest.mjs /b /work/origins.tsv /release/config.env
docker run --rm --network none -v "$B:/b" -w /b "$ALPINE_FETCH_IMAGE" sh -c '
  set -eu -o pipefail
  rm -f SHA256SUMS
  find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > /tmp/SHA256SUMS
  mv /tmp/SHA256SUMS SHA256SUMS
  want=$(find . -type f ! -name SHA256SUMS | wc -l); got=$(wc -l < SHA256SUMS)
  [ "$got" -eq "$want" ] || { echo "FAIL: SHA256SUMS has $got lines for $want files"; exit 1; }
  echo "SHA256SUMS: $got files"
  chown -R 0:0 .'

# 7. Completeness, offline.
docker run --rm --network none -v "$B:/b:ro" -v "$HERE:/tools:ro" --entrypoint node "$NODE_IMAGE" /tools/verify.mjs /b
