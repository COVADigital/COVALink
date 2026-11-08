# Source code for GPL- and LGPL-licensed components

The COVALink container image includes third-party components licensed under the GNU General Public License (GPL) and the GNU Lesser General Public License (LGPL). This document explains how to get their source code, and how to replace the LGPL-licensed libvips library in an image. COVALink's own source code is this repository, under the Apache License, Version 2.0.

[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) lists every component with its license.

## Which components

- **Alpine Linux packages of the base image,** including BusyBox, apk-tools and the Alpine base layout (GPL-2.0), and the GCC runtime libraries `libgcc`, `libstdc++` and `libatomic` (GPL-2.0-or-later and LGPL-2.1-or-later). Section 4 of the notices lists each package with its version, its source package and the Alpine `aports` commit it was built from.
- **The libvips library used by sharp,** shipped as the prebuilt, unmodified npm package `@img/sharp-libvips-linuxmusl-x64` (or `-arm64`) version 1.3.4. Its single shared library, `libvips-cpp.so.8.18.7`, contains libvips and the other libraries listed in that package's licensing table in the notices, including the LGPL-licensed fribidi, glib, libexif, libheif, librsvg, pango and proxy-libintl.

## Getting the source

### For a published image

**No COVALink image has been published yet.** From the first release on, every image published by this project is paired with a **source bundle** published in the same registry, under `ghcr.io/covadigital/covalink-sources`. The bundle holds:

- the Alpine `aports` recipes and the upstream source archives for the image's GPL- and LGPL-licensed packages, at the recorded commits, checked against the recipes' own checksums;
- the build scripts of the exact sharp-libvips version, with every source archive and patch its build uses;
- a manifest and checksums covering every file.

The pairing is by digest, not by tag: each image's notices name the digest of its source bundle, and a bundle stays available for as long as its image is. The release notes for each version give the commands to download and verify its bundle.

The prebuilt sharp-libvips package is used exactly as its maintainers publish it. Its bundle holds the version-specific build scripts and library sources, but the exact versions of the Rust crates the upstream build resolved can't be recovered from the prebuilt package, so the bundle doesn't claim to be a byte-for-byte reproduction of that binary.

### From upstream

The same sources are available from their upstream projects:

- **Alpine packages:** the `aports` repository, at <https://gitlab.alpinelinux.org/alpine/aports>, at the commit listed for each package in the notices. Each package's `APKBUILD` names its upstream source archives and their checksums.
- **sharp-libvips:** the build scripts are at <https://github.com/lovell/sharp-libvips>, tag `v1.3.4`, which list the version and download address of every library it builds.

Upstream addresses can change or disappear, which is why published images are paired with their own source bundles.

## Replacing libvips

Because the LGPL-licensed libraries are combined into one shared library, replacing any of them means building a new `libvips-cpp.so.8.18.7` and putting it in place of the one in the image.

1. **Build the library.** Use the sharp-libvips build scripts for version 1.3.4 (from the source bundle or upstream), with your modifications, for the same platform: Linux with musl, on x64 or arm64. The scripts produce an archive such as `sharp-libvips-linuxmusl-x64.tar.gz`; take `lib/libvips-cpp.so.8.18.7` from it.

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
