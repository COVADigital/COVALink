#!/usr/bin/env bash
# Refuses unless the active Buildx builder runs the pinned BuildKit release and
# web/Dockerfile's first line is the pinned frontend (release/config.env:
# BUILDKIT_IMAGE and DOCKERFILE_FRONTEND). Run from the repository root right
# after the builder is created, with config.env exported.
set -euo pipefail
: "${BUILDKIT_IMAGE:?}" "${DOCKERFILE_FRONTEND:?}"
[[ "$BUILDKIT_IMAGE" =~ ^moby/buildkit:(v[0-9]+\.[0-9]+\.[0-9]+)@sha256:[0-9a-f]{64}$ ]] || { echo "refused: BUILDKIT_IMAGE isn't a pinned moby/buildkit release"; exit 1; }
want=${BASH_REMATCH[1]}
got=$(docker buildx inspect --bootstrap | sed -n 's/^BuildKit version:[[:space:]]*//p' | head -1)
[[ "$got" == "$want" ]] || { echo "refused: the builder runs BuildKit ${got:-(unknown)}, not $want"; exit 1; }
first=$(head -1 web/Dockerfile | tr -d '\r')
[[ "$first" == "# syntax=$DOCKERFILE_FRONTEND" ]] || { echo "refused: web/Dockerfile's first line isn't the pinned frontend $DOCKERFILE_FRONTEND"; exit 1; }
echo "toolchain: BuildKit $got; frontend ${DOCKERFILE_FRONTEND%@*}"
