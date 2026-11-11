# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# COVALink production image. Build context: web/.
# The syntax line pins the Dockerfile frontend by digest (release/config.env,
# DOCKERFILE_FRONTEND); it must stay the first line.
#   docker build -t covalink:<git-sha> --build-arg GIT_SHA=<git-sha> web
# One image serves both the app (default command) and the one-shot migrator
# (command override `node scripts/migrate.mjs`); see ../compose.prod.yaml.
#
# Base image: Node 24 LTS on Alpine, exact patch pinned by manifest-list
# digest (amd64 + arm64). Update procedure: docs/DEPLOYMENT.md "Pinned images".
ARG NODE_IMAGE=node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

# ------------------------------------------------------------- patched-base --
# Temporary Alpine security update, applied on top of the pinned official image
# until a reviewed Node base-image digest ships the same or a newer fixed package
# (docs/DEPLOYMENT.md "Pinned images"). It installs exactly the version in
# release/config.env (ALPINE_ZLIB_VERSION) from Alpine's own repositories, with
# apk's normal signature verification; there is no --allow-untrusted or --force.
# --no-logfile keeps apk from appending a timestamped line to /var/log/apk.log,
# so the layer is the same on every build. The step fails unless that is the
# installed version and zlib is the only package that changed. Every later stage
# builds on this one, so nothing builds or runs against the vulnerable package.
FROM ${NODE_IMAGE} AS patched-base
RUN apk info -v | sort > /tmp/apk-before \
 && apk add --no-cache --no-logfile zlib=1.4-r0 \
 && apk info -v | sort > /tmp/apk-after \
 && added=$(comm -13 /tmp/apk-before /tmp/apk-after) \
 && removed=$(comm -23 /tmp/apk-before /tmp/apk-after) \
 && { [ "$added" = "zlib-1.4-r0" ] || { echo "expected to add exactly zlib-1.4-r0, added: $added"; exit 1; }; } \
 && if [ -n "$removed" ] && { [ "$(printf '%s\n' "$removed" | wc -l)" -ne 1 ] || printf '%s\n' "$removed" | grep -qvx 'zlib-[0-9][0-9a-z.]*-r[0-9]*'; }; then \
      echo "unexpected package change, removed: $removed"; exit 1; \
    fi \
 && zlib=$(awk '/^P:zlib$/{f=1} f&&/^V:/{print substr($0,3); exit}' /lib/apk/db/installed) \
 && { [ "$zlib" = "1.4-r0" ] || { echo "installed zlib is $zlib, not 1.4-r0"; exit 1; }; } \
 && rm -f /tmp/apk-before /tmp/apk-after

# ---------------------------------------------------------------- deps -------
# All dependencies, installed from the lockfile inside Linux, so sharp's
# linuxmusl prebuilt binary (and Next's musl SWC binary) is what gets installed.
# Install scripts are disabled: every native binary used here is a prebuilt
# optional package.
FROM patched-base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --loglevel=warn

# ---------------------------------------------------------------- build ------
# `next build` and the script bundler run with no network at all: the build
# cannot reach PostgreSQL or anything else. No environment or secrets are
# needed at build time; runtime configuration comes only from the container
# environment. Traced dependencies sometimes bring their own test folders;
# they are removed here so they never reach an image layer.
#
# Reproducible release builds: a full 40-character GIT_SHA becomes the Next.js
# build ID (next.config.ts; any other value keeps the default random ID). The
# Server Actions encryption key, when the release process supplies one, arrives
# only as the BuildKit secret "server_actions_key" (base64 of 32 bytes, checked
# by next.config.ts), so it never appears in a build argument, the image history,
# labels or provenance. Next.js embeds it in the server files of the build output,
# so it's recoverable from the image and isn't a secret. Without it, Next.js
# generates a random key as usual.
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
ARG GIT_SHA=unknown
RUN --network=none --mount=type=secret,id=server_actions_key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY COVALINK_BUILD_ID="$GIT_SHA" npm run build \
 && node scripts/bundle-runtime-scripts.mjs \
 && find .next/standalone/node_modules -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} +

# ---------------------------------------------------------------- runtime ----
FROM patched-base AS runtime
ARG GIT_SHA=unknown
# The source bundle that holds this image's third-party source code, by digest:
# <sources package>@sha256:<64 hex>. Empty for local builds, which have none.
ARG SOURCE_BUNDLE=
LABEL org.opencontainers.image.title="COVALink" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/COVADigital/COVALink" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.covalink.source-bundle="${SOURCE_BUNDLE}"

# The package managers in the base image are not needed at runtime. The
# writable mount points are owned by the runtime user (uid/gid 1000 = "node");
# a new named volume mounted at /data/uploads copies this ownership and mode.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /data/uploads /app/.next/cache \
 && chown 1000:1000 /data/uploads /app/.next/cache \
 && chmod 0700 /data/uploads

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DRIVER=local \
    STORAGE_LOCAL_PATH=/data/uploads \
    COVALINK_GIT_SHA=${GIT_SHA}

# Application files are owned by root and read-only to the runtime user.
# standalone = server.js + traced server dependencies + the bundled scripts
# (migrate, media-gc, healthcheck) and the files they load.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/src/db/migrations ./src/db/migrations

# License and notice files, and the source-bundle binding. THIRD_PARTY_NOTICES.txt
# is byte-identical to the repository copy; SOURCE_BUNDLE names the bundle by
# digest, matching the io.covalink.source-bundle label.
COPY --from=build /app/LICENSE /app/NOTICE /app/THIRD_PARTY_NOTICES.txt /app/CORRESPONDING_SOURCE.md ./
RUN case "$SOURCE_BUNDLE" in \
      "") printf 'none: built without a published source bundle\n' > SOURCE_BUNDLE ;; \
      *@sha256:*) printf '%s\n' "$SOURCE_BUNDLE" | grep -qE '^[a-z0-9./-]+@sha256:[0-9a-f]{64}$' \
           || { echo "SOURCE_BUNDLE must be <package>@sha256:<64 hex>"; exit 1; }; \
         printf '%s\n' "$SOURCE_BUNDLE" > SOURCE_BUNDLE ;; \
      *) echo "SOURCE_BUNDLE must be <package>@sha256:<64 hex>"; exit 1 ;; \
    esac \
 && chmod 0444 SOURCE_BUNDLE LICENSE NOTICE THIRD_PARTY_NOTICES.txt CORRESPONDING_SOURCE.md \
 && chmod -R go-w /app
# (Some build outputs, such as font files, arrive group-writable; nothing under
# /app is writable by group or others. .next/cache stays writable by its owner.)

USER 1000:1000
EXPOSE 3000
VOLUME ["/data/uploads"]
# Liveness only (no database). Compose/Coolify adds the readiness gate.
HEALTHCHECK --interval=15s --timeout=6s --start-period=30s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "server.js"]
