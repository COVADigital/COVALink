import "server-only";
import { after } from "next/server";
import nodemailer, { type Transporter } from "nodemailer";
import { env, smtpConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  const e = env();
  transporter = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT ?? (e.SMTP_SECURE ? 465 : 587),
    secure: e.SMTP_SECURE,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
  });
  return transporter;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Which kind of message; the only detail that ever reaches a log line. */
export type MailKind = "password-reset" | "email-verification";

/** Replaces SMTP delivery (tests only; `null` restores SMTP). */
export type MailTransport = (msg: MailMessage) => Promise<void>;
let transportOverride: MailTransport | null = null;
export function setMailTransport(transport: MailTransport | null) {
  transportOverride = transport;
}

/**
 * Sends mail via SMTP. Without SMTP configuration the message is logged in
 * development (so verification/reset links still work locally) and dropped
 * with a warning in production.
 */
export async function sendMail(msg: MailMessage): Promise<void> {
  if (transportOverride) return transportOverride(msg);
  if (!smtpConfigured()) {
    if (env().NODE_ENV !== "production") {
      logger.info({ to: msg.to, subject: msg.subject }, `[mail:dev] ${msg.text}`);
    } else {
      logger.warn({ subject: msg.subject }, "SMTP is not configured; email not sent");
    }
    return;
  }
  await getTransporter().sendMail({ from: env().SMTP_FROM, ...msg });
}

/**
 * Only fixed, non-identifying fields of a delivery error: SMTP and socket
 * errors can quote the recipient or the message, which carries a token.
 */
export function scrubMailError(err: unknown): { name?: string; code?: string; responseCode?: number } {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; responseCode?: unknown };
  return {
    ...(typeof e.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) && { name: e.name }),
    ...(typeof e.code === "string" && /^[A-Z0-9_]{1,40}$/.test(e.code) && { code: e.code }),
    ...(typeof e.responseCode === "number" && Number.isInteger(e.responseCode) && { responseCode: e.responseCode }),
  };
}

async function deliver(msg: MailMessage, kind: MailKind) {
  try {
    await sendMail(msg);
  } catch (err) {
    logger.error({ kind, error: scrubMailError(err) }, "Email delivery failed");
  }
}

/**
 * Starts delivery without waiting for it: the public response must not
 * depend on how long SMTP takes or whether it fails. Inside a Next.js request
 * the work is registered with `after()`, which `next start` keeps running after
 * the response; outside one (scripts, tests) it runs as a detached promise.
 * Never throws.
 */
export function dispatchMail(msg: MailMessage, kind: MailKind): void {
  const task = () => deliver(msg, kind);
  try {
    after(task);
  } catch {
    void task();
  }
}

/**
 * The link put in an email. The token travels in the fragment, which browsers
 * never send to a server, so it can't reach access logs, referrers or caches.
 */
export function tokenLink(page: "/reset-password" | "/verify-email", token: string): string {
  return `${env().APP_URL.replace(/\/+$/, "")}${page}#token=${encodeURIComponent(token)}`;
}

export function actionEmail(opts: { heading: string; body: string; actionLabel: string; url: string }) {
  const text = `${opts.heading}\n\n${opts.body}\n\n${opts.actionLabel}: ${opts.url}\n\nIf you didn't request this, you can ignore this email.`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f4f4f5;padding:32px">
<table role="presentation" style="max-width:480px;margin:auto;background:#fff;border-radius:12px;padding:32px">
<tr><td><h1 style="font-size:20px;margin:0 0 12px">${esc(opts.heading)}</h1>
<p style="color:#3f3f46;line-height:1.5">${esc(opts.body)}</p>
<p style="margin:24px 0"><a href="${esc(opts.url)}" style="background:#18181b;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">${esc(opts.actionLabel)}</a></p>
<p style="color:#71717a;font-size:13px">If you didn't request this, you can ignore this email.</p></td></tr></table></body></html>`;
  return { text, html };
}
