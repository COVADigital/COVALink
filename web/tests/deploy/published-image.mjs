// Rules for the deployment smoke test's published-image mode (SMOKE_IMAGE),
// kept separate so release/gates/test/ can check that they reject bad input.

/** SMOKE_IMAGE must name an image by digest: <registry/name>@sha256:<64 hex>. */
export const PUBLISHED_IMAGE = /^[a-z0-9.\-/:]+@sha256:[0-9a-f]{64}$/;

/**
 * The commit a published image reports as its version: its COVALINK_GIT_SHA,
 * which must be a full 40-character commit SHA. Throws for anything else, so a
 * missing, empty or placeholder value can never pass as the expected version.
 */
export function revisionFromEnv(env) {
  const entries = Array.isArray(env) ? env.filter((e) => typeof e === "string" && e.startsWith("COVALINK_GIT_SHA=")) : [];
  if (entries.length !== 1) throw new Error(`published image has ${entries.length} COVALINK_GIT_SHA entries, not one`);
  const sha = entries[0].slice("COVALINK_GIT_SHA=".length);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`published image's COVALINK_GIT_SHA is "${sha}", not a commit`);
  return sha;
}
