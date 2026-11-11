#!/usr/bin/env bash
# Refuses unless neither production tag for this release exists yet:
# <PRODUCTION_PACKAGE>:<VERSION> and <PRODUCTION_PACKAGE>:sha-<RUN_SHA>.
# Only a clear "not found" from the registry counts as absent; any other error
# refuses, so an outage or an authentication problem can't look like absence.
set -euo pipefail
: "${PRODUCTION_PACKAGE:?}" "${VERSION:?}" "${RUN_SHA:?}"
for tag in "$VERSION" "sha-$RUN_SHA"; do
  if out=$(docker buildx imagetools inspect "$PRODUCTION_PACKAGE:$tag" 2>&1); then
    echo "refused: $PRODUCTION_PACKAGE:$tag already exists"; exit 1
  fi
  if ! grep -qiE 'not found|manifest unknown|name unknown' <<< "$out"; then
    echo "refused: couldn't confirm that $PRODUCTION_PACKAGE:$tag is absent"; exit 1
  fi
done
echo "production tags $VERSION and sha-$RUN_SHA are absent"
