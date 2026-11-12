#!/usr/bin/env bash
# First step of every release workflow job. Refuses unless:
#   - VERSION is a plain semantic version (for example 0.1.0);
#   - the run is on exactly refs/tags/v<VERSION> (RUN_REF);
#   - RUN_SHA is that tag's commit, and the commit is on master.
# Inputs arrive only through the environment. Run inside a checkout.
set -euo pipefail
[[ "${VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "refused: version must look like 0.1.0"; exit 1; }
[[ "${RUN_REF:-}" == "refs/tags/v$VERSION" ]] || { echo "refused: the run must be on refs/tags/v$VERSION"; exit 1; }
[[ "${RUN_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "refused: commit is malformed"; exit 1; }
tag_commit=$(git rev-parse "refs/tags/v$VERSION^{commit}" 2>/dev/null || true)
[[ "$tag_commit" == "$RUN_SHA" ]] || { echo "refused: tag v$VERSION doesn't point at this run's commit"; exit 1; }
git fetch --quiet --no-tags origin "+refs/heads/master:refs/remotes/origin/master"
git merge-base --is-ancestor "$RUN_SHA" refs/remotes/origin/master || { echo "refused: the tag's commit isn't on master"; exit 1; }
echo "guard: v$VERSION at $RUN_SHA, on master"
