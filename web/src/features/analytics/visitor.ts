import { createHash, randomBytes } from "node:crypto";

/**
 * Pseudonymous daily visitor identifiers. Pure; the salt comes
 * from `salts.ts`. The hash covers the UTC day's random salt, the trusted
 * client address, the coarse user-agent class and the profile id, NUL
 * separated so no two inputs can run together. It is computed only when a
 * trusted address exists; there is no hash of a placeholder.
 *
 * Once the day's salt is deleted (`analytics:purge` keeps today and
 * yesterday), nobody, including the operator, can recompute or confirm a
 * hash from an address. Until then, anyone with database access and a
 * candidate address could test it, so hashes are treated as sensitive.
 */
export function visitorHash({
  salt,
  address,
  uaClass,
  profileId,
}: {
  salt: string;
  address: string;
  uaClass: string;
  profileId: string;
}): string {
  return createHash("sha256").update([salt, address, uaClass, profileId].join("\u0000")).digest("hex");
}

/** 32 cryptographically random bytes, base64url (43 characters). */
export function newSalt(): string {
  return randomBytes(32).toString("base64url");
}
