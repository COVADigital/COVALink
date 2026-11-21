import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { attemptsUsed, consumeAttempt, purgeAttempts } from "@/features/account/throttle";
import { readBounded } from "@/features/analytics/beacon";
import { isBot } from "@/features/analytics/classify";
import { getLiveProfileById, getPublishedDocument } from "@/features/profiles/public";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { actionEmail, dispatchMail, tokenLink, type MailMessage } from "@/lib/mail";
import { trustedClientAddress } from "@/lib/security/client-address";
import { isSameOrigin } from "@/lib/security/origin";
import { canonicalPhone, hasControlChars, hasControlCharsExceptLf } from "@/features/blocks/contact-points";
import { getCard } from "@/features/cards/service";
import { cardConsentText, consentText, plainName } from "./consent";
import { confirmSignup, recordSignup, removeSignup } from "./service";
import { ownerVerified, subscribeStatus } from "./status";

/**
 * Rate-limit key part for a client address or an email, so the table holds neither. Keyed with a sub-key derived
 * from the server secret, kept apart from the secret's other uses.
 */
export const limitKey = (value: string) => {
  const subKey = createHmac("sha256", env().BETTER_AUTH_SECRET).update("covalink:subscribe-limit").digest();
  return createHmac("sha256", subKey).update(value).digest("hex");
};

/**
 * The anonymous Subscribe endpoints. Like the view beacon, they accept only
 * same-origin JSON with a small body. `POST /api/subscribe` answers every
 * accepted request with the same 202, whether the address was new, pending,
 * already confirmed, a honeypot hit, a bot, over the per-address limit, the card's share-back is off, the
 * block is gone, its owner's email isn't verified, or the server can't tell
 * visitors apart (no trusted client address), so it can't be used to
 * learn who is subscribed. Only the client-, profile- and installation-wide
 * rate limits answer 429.
 */

export const MAX_SUBSCRIBE_BYTES = 2048;

/** Sign-ups per window: per trusted client address, per profile, for the installation, per email address. */
export const SUBSCRIBE_LIMITS = { windowSeconds: 3600, perClient: 10, perProfile: 60, global: 600, perEmail: 3 };

const emailField = z.string().max(320).trim().toLowerCase().pipe(z.email().max(254));

/** A Subscribe block (`b`, its id) or the business card's share-back form (`c: "card"`: a name, and optionally a phone and a note). */
const subscribeSchema = z.union([
  z.object({ p: z.uuid(), b: z.uuid(), email: emailField, hp: z.string().max(200) }).strict(),
  z
    .object({
      p: z.uuid(),
      c: z.literal("card"),
      name: z
        .string()
        .max(200)
        .refine((v) => !hasControlChars(v))
        .trim()
        .min(1)
        .max(100),
      email: emailField,
      // Optional; stored canonical. Unlike the email, it isn't verified.
      phone: z
        .string()
        .max(64)
        .transform((v) => (v.trim() ? canonicalPhone(v) : ""))
        .refine((v) => v !== null)
        .optional(),
      note: z
        .string()
        .max(1000)
        .refine((v) => !hasControlCharsExceptLf(v))
        // Invisible format characters (direction overrides, zero-width marks) are dropped, as in names.
        .transform((v) => v.replace(/\p{Cf}+/gu, "").trim())
        .pipe(z.string().max(500))
        .optional(),
      hp: z.string().max(200),
    })
    .strict(),
]);

const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

const json = (status: number, body?: object) =>
  new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { "cache-control": "no-store", ...(body && { "content-type": "application/json" }) },
  });

/** The beacon's request gate: same origin, JSON, a bounded body. The parsed body, or the refusal. */
async function readJson(request: Request): Promise<{ body: unknown } | { refusal: Response }> {
  if (!isSameOrigin(request, new URL(env().APP_URL).origin)) return { refusal: json(403) };
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) return { refusal: json(415) };
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,7}$/.test(declared) || Number(declared) > MAX_SUBSCRIBE_BYTES)) return { refusal: json(413) };
  const text = await readBounded(request, MAX_SUBSCRIBE_BYTES);
  if (text === null) return { refusal: json(413) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { refusal: json(400) };
  }
}

export interface SubscribeDeps {
  send: (msg: MailMessage) => void;
  trustProxy: boolean;
}

export async function handleSubscribe(request: Request, deps: Partial<SubscribeDeps> = {}): Promise<Response> {
  const read = await readJson(request);
  if ("refusal" in read) return read.refusal;
  const parsed = subscribeSchema.safeParse(read.body);
  if (!parsed.success) return json(400);
  const accepted = json(202, { ok: true });
  const { p: profileId, hp, email } = parsed.data;
  const blockId = "b" in parsed.data ? parsed.data.b : null;
  const visitorName = "name" in parsed.data ? plainName(parsed.data.name) : undefined;
  const details = "c" in parsed.data ? { phone: parsed.data.phone || undefined, note: parsed.data.note || undefined } : {};

  if (hp || isBot(request.headers.get("user-agent"))) return accepted;
  const { windowSeconds: w, perClient, perProfile, global, perEmail } = SUBSCRIBE_LIMITS;
  // Sign-ups need a per-visitor limit, so without a trusted client address (TRUST_PROXY off) none are taken.
  const address = trustedClientAddress(request.headers, deps.trustProxy ?? env().TRUST_PROXY);
  if (!address) return accepted;
  // Refused attempts don't restart these windows, so a trickle of attempts can't keep sign-ups closed.
  const fixed = { refusedExtend: false };
  if (!(await consumeAttempt(`subscribe:client:${limitKey(address)}`, w, perClient, fixed))) return json(429);

  if (!(await subscribeStatus()).live) return accepted;
  const live = await getLiveProfileById(profileId);
  const published = live ? await getPublishedDocument(live) : null;
  if (!live || !published) return accepted;
  // The card's form is open only while its share-back switch is on; its consent line names the card.
  const card = blockId ? null : await getCard(live.id, published.header.displayName);
  if (blockId) {
    const block = published.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "subscribe" || !block.visible) return accepted;
  } else if (!card?.shareBack || !visitorName) return accepted;
  if (!(await ownerVerified(live.ownerId))) return accepted;

  // The per-address limit is silent, so it reveals nothing. It is read first, so repeats of one address don't use up
  // the shared limits, and counted only after them, so new rows stay within the installation-wide limit.
  const emailKey = `subscribe:email:${limitKey(`${profileId}\u0000${email}`)}`;
  if ((await attemptsUsed(emailKey, w)) >= perEmail) return accepted;
  if (!(await consumeAttempt(`subscribe:profile:${profileId}`, w, perProfile, fixed))) return json(429);
  if (!(await consumeAttempt("subscribe:global", w, global, fixed))) return json(429);
  if (!(await consumeAttempt(emailKey, w, perEmail, fixed))) return accepted;

  const name = plainName(card ? card.displayName : published.header.displayName);
  try {
    await purgeAttempts("subscribe:", w);
    const consent = card ? cardConsentText(name) : consentText(name);
    const tokens = await recordSignup({ profileId, blockId, name: visitorName, ...details, email, consentText: consent });
    if (tokens) {
      const confirmUrl = tokenLink("/subscribe/confirm", tokens.confirmToken);
      const removeUrl = tokenLink("/subscribe/remove", tokens.removeToken);
      // The name is user-supplied, so it stays out of the subject and is quoted in the body.
      const content = actionEmail({
        heading: "Confirm your subscription",
        // A card sign-up lists what it shares. Visitor-typed text (name, note) is never echoed, so the form can't relay messages
        // to arbitrary inboxes; the phone is canonical digits, so it can't carry text.
        body: card
          ? `Someone, hopefully you, asked to share contact details with "${name}" after scanning a COVALink business card: this email address, a name${details.phone ? `, the phone number ${details.phone}` : ""}${details.note ? " and a note" : ""}. Confirm to share them with the card's owner. The link works for 48 hours.`
          : `Someone, hopefully you, asked to join the email list of the COVALink page "${name}". Confirm to share your email address with its owner. The link works for 48 hours.`,
        actionLabel: "Confirm subscription",
        url: confirmUrl,
        footer: { text: "Not you, or changed your mind?", label: "Remove my email", url: removeUrl },
      });
      const msg = { to: email, subject: "Confirm your subscription", ...content };
      (deps.send ?? ((m: MailMessage) => dispatchMail(m, "subscribe-confirm")))(msg);
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "unknown", profileId }, "Recording a sign-up failed");
  }
  return accepted;
}

/** `POST /api/subscribe/confirm` and `/remove`: the token from the emailed link's fragment. */
export async function handleSubscribeToken(request: Request, action: "confirm" | "remove"): Promise<Response> {
  const read = await readJson(request);
  if ("refusal" in read) return read.refusal;
  const parsed = tokenSchema.safeParse(read.body);
  if (!parsed.success) return json(400, { ok: false });
  const ok = await (action === "confirm" ? confirmSignup : removeSignup)(parsed.data.token).catch(() => false);
  return json(ok ? 200 : 410, { ok });
}
