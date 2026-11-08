# COVALink production image. Build context: web/.
#   docker build -t covalink:<git-sha> --build-arg GIT_SHA=<git-sha> web
# One image serves both the app (default command) and the one-shot migrator
# (command override `node scripts/migrate.mjs`); see ../compose.prod.yaml.
#
# Base image: Node 24 LTS on Alpine, exact patch pinned by manifest-list
# digest (amd64 + arm64). Update procedure: docs/DEPLOYMENT.md "Pinned images".
ARG NODE_IMAGE=node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

# ---------------------------------------------------------------- deps -------
# All dependencies, installed from the lockfile inside Linux, so sharp's
# linuxmusl prebuilt binary (and Next's musl SWC binary) is what gets installed.
# Install scripts are disabled: every native binary used here is a prebuilt
# optional package.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --loglevel=warn

# ---------------------------------------------------------------- build ------
# `next build` and the script bundler run with no network at all: the build
# cannot reach PostgreSQL or anything else. No environment or secrets are
# needed at build time; runtime configuration comes only from the container
# environment. Traced dependencies sometimes bring their own test folders;
# they are removed here so they never reach an image layer.
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN --network=none npm run build \
 && node scripts/bundle-runtime-scripts.mjs \
 && find .next/standalone/node_modules -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} +

# ---------------------------------------------------------------- runtime ----
FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="COVALink" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="covalink"

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

USER 1000:1000
EXPOSE 3000
VOLUME ["/data/uploads"]
# Liveness only (no database). Compose/Coolify adds the readiness gate.
HEALTHCHECK --interval=15s --timeout=6s --start-period=30s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "server.js"]
