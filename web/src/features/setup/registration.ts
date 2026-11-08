import "server-only";
import { getSetting } from "@/features/settings/service";
import { isBootstrapped } from "./service";

export type RegistrationDecision =
  | { allowed: true }
  | { allowed: false; reason: "not_bootstrapped" | "closed" | "invite_only"; message: string };

/**
 * Single source of truth for whether a public sign-up may proceed. Called by
 * the Better Auth `user.create.before` hook (authoritative, covers direct API
 * calls) and by the /register page (to show the right message).
 */
export async function registrationDecision(): Promise<RegistrationDecision> {
  if (!(await isBootstrapped())) {
    return { allowed: false, reason: "not_bootstrapped", message: "This server hasn't been set up yet." };
  }
  if (!(await getSetting("registration.enabled"))) {
    return { allowed: false, reason: "closed", message: "Registration is closed on this server." };
  }
  // Invitation acceptance isn't implemented yet, so invite-only means closed.
  if (await getSetting("registration.inviteOnly")) {
    return { allowed: false, reason: "invite_only", message: "Registration on this server is by invitation only." };
  }
  return { allowed: true };
}
