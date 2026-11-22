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
import { ipv6Site, trustedClientAddress } from "@/lib/security/client-address";
import { isSameOrigin } from "@/lib/security/origin";
import { canonicalPhone, hasControlChars, hasControlCharsExceptLf } from "@/features/blocks/contact-points";
import { getCard } from "@/features/cards/service";
import { cardConsentText, consentText, plainName } from "./consent";
import { confirmSignup, previewSignup, recordSignup, removeSignup } from "./service";
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
 * already confirmed, a honeypot hit, a bot, over the per-recipient limit, the card's share-back is off, the
 * block is gone, its owner's email isn't verified, or the server can't tell
 * visitors apart (no trusted client address), so it can't be used to
 * learn who is subscribed. Only the client, site, profile, owner and installation-wide
 * rate limits answer 429, and none of them depends on the address.
 */

/** Every field at its schema maximum, at 3 UTF-8 bytes per UTF-16 unit (CJK), fits with room to spare. */
export const MAX_SUBSCRIBE_BYTES = 8192;

/**
 * Sign-ups per window (fixed, from the first attempt): per trusted client address (/64 for IPv6), per IPv6 /48 site,
 * per profile, per owner across their profiles, for the installation, and confirmation emails per recipient (across
 * profiles, `+tag` ignored). Owner and recipient also have a daily cap, and one sender (IPv4 address or IPv6 /48) a
 * daily cap per owner.
 */
export const SUBSCRIBE_LIMITS = {
  windowSeconds: 3600,
  perClient: 10,
  perSite: 20,
  perProfile: 60,
  perOwner: 60,
  global: 600,
  perRecipient: 3,
  daySeconds: 86400,
  perOwnerDay: 200,
  perSenderOwnerDay: 20,
  perRecipientDay: 10,
};

/** The recipient's limit key: `+tag`s address one inbox under many names. Only the key; the address is stored and sent as typed. */
export const recipientKey = (email: string) => email.replace(/\+[^@]*(?=@[^@]*$)/, "");

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

const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), preview: z.literal(true).optional() }).strict();

/** How emails and the confirm page name a profile: `host/handle`, never owner-typed text. */
const pageName = (handle: string) => `${new URL(env().APP_URL).host}/${handle}`;

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
  const L = SUBSCRIBE_LIMITS;
  const w = L.windowSeconds;
  // Sign-ups need a per-visitor limit, so without a trusted client address (TRUST_PROXY off) none are taken.
  const address = trustedClientAddress(request.headers, deps.trustProxy ?? env().TRUST_PROXY);
  if (!address) return accepted;
  // Checked before anything is stored, so an installation with sign-ups off keeps no per-visitor rows.
  if (!(await subscribeStatus()).live) return accepted;
  // Nor do requests for unknown or unpublished profiles: every row written below is followed by the purge.
  const live = await getLiveProfileById(profileId);
  const published = live ? await getPublishedDocument(live) : null;
  if (!live || !published) return accepted;

  // Fixed windows: refused attempts don't move them, so a trickle of attempts can't keep sign-ups closed.
  const fixed = { refusedExtend: false };
  // While the installation is full, nothing is counted, so retries don't extend a visitor's or an owner's windows.
  if ((await attemptsUsed("subscribe:global", w)) >= L.global) return json(429);
  // One site rotating through its /64s still shares one /48 limit. It goes first, so once it refuses, new /64s add no
  // rows; a refused request only counts on an existing row, which is why skipping the purge below costs nothing.
  const site = ipv6Site(address);
  if (site && !(await consumeAttempt(`subscribe:site:${limitKey(site)}`, w, L.perSite, fixed))) return json(429);
  if (!(await consumeAttempt(`subscribe:client:${limitKey(address)}`, w, L.perClient, fixed))) return json(429);
  // Expired limit rows go on every request for a live profile that passes the per-visitor limits, not only on a
  // successful sign-up, so rows from visitors whose requests are later dropped don't pile up. A failed cleanup doesn't
  // block the request.
  await Promise.all([purgeAttempts("subscribe:", w), purgeAttempts("subscribe-day:", L.daySeconds)]).catch((err: unknown) =>
    logger.error({ err: err instanceof Error ? err.name : "unknown" }, "Purging sign-up limit rows failed"),
  );
  // The card's form is open only while its share-back switch is on; its consent line names the card.
  const card = blockId ? null : await getCard(live.id, published.header.displayName);
  if (blockId) {
    const block = published.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "subscribe" || !block.visible) return accepted;
  } else if (!card?.shareBack || !visitorName) return accepted;
  if (!(await ownerVerified(live.ownerId))) return accepted;

  // The shared limits answer 429 the same for every address, so they run before the per-recipient limit, which is
  // silent: checking it first would let a full shared limit reveal which addresses signed up recently. Recipient rows
  // are written only past the installation-wide limit.
  // One sender (an IPv4 address or an IPv6 /48) can use only part of an owner's daily quota, so closing an owner's
  // sign-ups for the day takes many senders.
  const sender = `subscribe-day:sender:${limitKey(`${site ?? address}\u0000${live.ownerId}`)}`;
  if (!(await consumeAttempt(sender, L.daySeconds, L.perSenderOwnerDay, fixed))) return json(429);
  if (!(await consumeAttempt(`subscribe:profile:${live.id}`, w, L.perProfile, fixed))) return json(429);
  if (!(await consumeAttempt(`subscribe:owner:${live.ownerId}`, w, L.perOwner, fixed))) return json(429);
  if (!(await consumeAttempt(`subscribe-day:owner:${live.ownerId}`, L.daySeconds, L.perOwnerDay, fixed))) return json(429);
  if (!(await consumeAttempt("subscribe:global", w, L.global, fixed))) return json(429);
  const to = limitKey(recipientKey(email));
  const hour = `subscribe:to:${to}`;
  const day = `subscribe-day:to:${to}`;
  if ((await attemptsUsed(hour, w)) >= L.perRecipient || (await attemptsUsed(day, L.daySeconds)) >= L.perRecipientDay) return accepted;
  const [inHour, inDay] = await Promise.all([
    consumeAttempt(hour, w, L.perRecipient, fixed),
    consumeAttempt(day, L.daySeconds, L.perRecipientDay, fixed),
  ]);
  if (!inHour || !inDay) return accepted;

  // The email names the page by its address, not the owner-typed display or card name, so an account can't use the
  // form to deliver its own text to arbitrary inboxes. The stored consent wording keeps the name the visitor saw.
  const page = pageName(live.handle);
  try {
    const name = plainName(card ? card.displayName : published.header.displayName);
    const consent = card ? cardConsentText(name) : consentText(name);
    const tokens = await recordSignup({ profileId: live.id, blockId, name: visitorName, ...details, email, consentText: consent });
    if (tokens) {
      const confirmUrl = tokenLink("/subscribe/confirm", tokens.confirmToken);
      const removeUrl = tokenLink("/subscribe/remove", tokens.removeToken);
      const content = actionEmail({
        heading: "Confirm your subscription",
        // A card sign-up lists what it shares but echoes none of what the visitor typed (name, phone, note), so the
        // form can't deliver chosen text or a callback number to an arbitrary inbox. The confirm page shows the details.
        body: card
          ? `Someone, hopefully you, asked to share contact details with the owner of the COVALink page ${page} after scanning their business card: this email address, a name${details.phone ? ", a phone number" : ""}${details.note ? " and a note" : ""}. Open the link to review them, then confirm to share them. The link works for 48 hours.`
          : `Someone, hopefully you, asked to join the email list of the COVALink page ${page}. Confirm to share your email address with its owner. The link works for 48 hours.`,
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

/**
 * `POST /api/subscribe/confirm` and `/remove`: the token from the emailed link's fragment. `/confirm` with `preview:
 * true` changes nothing and answers what confirming would share, so the visitor sees the details first.
 */
export async function handleSubscribeToken(request: Request, action: "confirm" | "remove"): Promise<Response> {
  const read = await readJson(request);
  if ("refusal" in read) return read.refusal;
  const parsed = tokenSchema.safeParse(read.body);
  if (!parsed.success || (parsed.data.preview && action !== "confirm")) return json(400, { ok: false });
  if (parsed.data.preview) {
    const found = await previewSignup(parsed.data.token).catch(() => null);
    if (!found) return json(410, { ok: false });
    return json(200, { ok: true, page: pageName(found.handle), name: found.name, phone: found.phone, note: found.note });
  }
  const ok = await (action === "confirm" ? confirmSignup : removeSignup)(parsed.data.token).catch(() => false);
  return json(ok ? 200 : 410, { ok });
}
