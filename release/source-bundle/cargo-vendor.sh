#!/bin/sh
# Runs inside the pinned libvips build environment, with network access.
# Repeats the librsvg steps of sharp-libvips' build/posix.sh (the same Cargo.toml
# edits, `cargo update --workspace`, then the same patch) and vendors exactly
# the Rust crates that resolution produced, so the bundle holds them.
set -eu
S=/bundle/sharp-libvips/sources
idx=$S/urls.tsv
rsvg=$(awk -F'\t' '$1 ~ /\/librsvg-[0-9.]+\.tar\.xz$/ {print $2}' "$idx")
patch=$(awk -F'\t' '$1 ~ /github\.com\/GNOME\/librsvg\/commit\/[0-9a-f]+\.patch$/ {print $2}' "$idx")
[ -n "$rsvg" ] && [ -n "$patch" ] || { echo "FAIL: librsvg source or patch not in the bundle index"; exit 1; }
mkdir -p /tmp/rsvg && cd /tmp/rsvg
tar xJf "$S/$rsvg" --strip-components=1
sed -i'.bak' "/image = /s/, \"gif\", \"webp\"//" rsvg/Cargo.toml
sed -i'.bak' "/cairo-rs = /s/, \"pdf\", \"ps\"//" librsvg-c/Cargo.toml rsvg/Cargo.toml
sed -i'.bak' "/^if host_system in \['windows'/s/, 'linux'//" meson.build
cargo update --workspace
patch -p1 < "$S/$patch"
mkdir -p /bundle/sharp-libvips/cargo
cargo vendor --locked --versioned-dirs /bundle/sharp-libvips/cargo/vendor > /dev/null
cp Cargo.lock /bundle/sharp-libvips/cargo/Cargo.lock.resolved
echo "ok cargo: $(ls /bundle/sharp-libvips/cargo/vendor | wc -l) crates vendored for $(grep -c '^name = ' Cargo.lock) locked packages"
