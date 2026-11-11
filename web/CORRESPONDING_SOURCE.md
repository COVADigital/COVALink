# Source code for GPL- and LGPL-licensed components

The COVALink container image includes third-party components licensed under the GNU General Public License (GPL) and the GNU Lesser General Public License (LGPL). This document explains how to get their source code, and how to replace the LGPL-licensed libvips library in an image. COVALink's own source code is this repository, under the Apache License, Version 2.0.

[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) lists every component with its license.

## Which components

- **Alpine Linux packages of the base image,** including BusyBox, apk-tools and the Alpine base layout (GPL-2.0), and the GCC runtime libraries `libgcc`, `libstdc++` and `libatomic` (GPL-2.0-or-later and LGPL-2.1-or-later). Section 4 of the notices lists each package with its version, its source package and the Alpine `aports` commit it was built from.
- **The libvips library used by sharp,** shipped as the prebuilt, unmodified npm package `@img/sharp-libvips-linuxmusl-x64` (or `-arm64`) version 1.3.4. Its single shared library, `libvips-cpp.so.8.18.7`, contains libvips and the other libraries listed in that package's licensing table in the notices, including the LGPL-licensed fribidi, glib, libexif, libheif, librsvg, pango and proxy-libintl.

## Getting the source

### For a published image

**No COVALink image has been published yet.** From the first release on, every image published by this project (for `linux/amd64`) is paired with a **source bundle** published in the same registry, under `ghcr.io/covadigital/covalink-sources`. The bundle holds:

- the Alpine `aports` recipe and the upstream source archives of every Alpine source package in the base image, at the recorded commits, checked against the recipes' own checksums;
- the build scripts of the exact sharp-libvips version, with every source archive and patch its build uses, the Rust crates resolved for that build, vendored, and a rebuild kit (`rebuild-kit/REBUILD.md`) that builds the library from the bundle with no network;
- `MANIFEST.json`, which records every component and file with its checksum, and `SHA256SUMS`, which covers every file.

The pairing is by digest, not by tag. Each image names its bundle's digest in the file `/app/SOURCE_BUNDLE` and in its `io.covalink.source-bundle` label, and the release process checks that both agree with the bundle it published. A bundle stays available for as long as its image is.

**Find an image's bundle:**

```sh
docker run --rm --network none --entrypoint cat <COVALink image reference> /app/SOURCE_BUNDLE
```

It prints a reference of the form `ghcr.io/covadigital/covalink-sources@sha256:<digest>`.

**Download it,** with Docker:

```sh
docker pull <bundle reference>
id=$(docker create <bundle reference> none)
docker cp "$id:/covalink-sources" ./covalink-sources
docker rm "$id"
```

or, with no Docker and no registry account, using Node.js 24 and `tar` on Linux from a checkout of this repository: `node release/source-bundle/retrieve.mjs <bundle reference> ./out`, which checks every digest and extracts the bundle to `./out/covalink-sources`.

**Verify it:** `cd covalink-sources && sha256sum -c SHA256SUMS` checks every file. `node release/source-bundle/verify.mjs covalink-sources`, on Linux from a checkout of this repository, also checks it against the manifest, the Alpine recipes' checksums, the sharp-libvips build scripts and the crate checksums, with no network.

The prebuilt sharp-libvips package is used exactly as its maintainers publish it. Its bundle holds the version-specific build scripts and library sources, but the exact versions of the Rust crates the upstream build resolved can't be recovered from the prebuilt package: the vendored crates repeat that resolution, so the bundle doesn't claim to be a byte-for-byte reproduction of that binary. The license and copyright files from every component in the bundle are in sections 5 and 6 of [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

### From upstream

The same sources are available from their upstream projects:

- **Alpine packages:** the `aports` repository, at <https://gitlab.alpinelinux.org/alpine/aports>, at the commit listed for each package in the notices. Each package's `APKBUILD` names its upstream source archives and their checksums.
- **sharp-libvips:** the build scripts are at <https://github.com/lovell/sharp-libvips>, tag `v1.3.4`, which list the version and download address of every library it builds.

Upstream addresses can change or disappear, which is why published images are paired with their own source bundles.

## Replacing libvips

Because the LGPL-licensed libraries are combined into one shared library, replacing any of them means building a new `libvips-cpp.so.8.18.7` and putting it in place of the one in the image.

1. **Build the library.** Use the sharp-libvips build scripts for version 1.3.4 (from the source bundle, following its `rebuild-kit/REBUILD.md`, or upstream), with your modifications, for the same platform: Linux with musl, on x64 (published images) or arm64. The scripts produce an archive such as `sharp-libvips-linuxmusl-x64.tar.gz`; take `lib/libvips-cpp.so.8.18.7` from it.

2. **Put it in a derived image.** The library is at `/app/node_modules/@img/sharp-libvips-linuxmusl-x64/lib/` (or `-arm64`) in the image:

   ```dockerfile
   FROM <COVALink image reference>
   COPY libvips-cpp.so.8.18.7 /app/node_modules/@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.18.7
   ```

   When you build the image yourself from this repository, you can instead replace the file under `web/node_modules/@img/` before building.

3. **Check that it loads and works:**

   ```sh
   docker run --rm --network none -w /app --entrypoint node <your image> -e \
     "require('sharp')({create:{width:8,height:8,channels:3,background:'#336699'}}).webp().toBuffer().then(b=>console.log('ok',b.length))"
   ```

   It prints `ok` and a byte count. Then upload an image through the application to confirm that the full pipeline works.

The replacement library must keep the same file name and a compatible interface, because sharp's own native module links to it.
