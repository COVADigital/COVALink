import type { MailMessage, MailTransport } from "@/lib/mail";

export interface MailCapture {
  sent: MailMessage[];
  /** Transport behavior for the next deliveries. */
  mode: { delayMs?: number; fail?: boolean };
  clear(): void;
  /** Waits until at least `count` messages arrived (delivery runs after the response). */
  waitFor(count: number, timeoutMs?: number): Promise<MailMessage[]>;
  /** Waits briefly and asserts nothing more was sent. */
  settle(ms?: number): Promise<void>;
}

/**
 * Installs an injectable mail transport that records every message. Pass the
 * `setMailTransport` of the module graph under test.
 */
export function captureMail(setMailTransport: (t: MailTransport | null) => void): MailCapture {
  const capture: MailCapture = {
    sent: [],
    mode: {},
    clear() {
      capture.sent.length = 0;
      capture.mode = {};
    },
    async waitFor(count, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (capture.sent.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} message(s), got ${capture.sent.length}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return capture.sent;
    },
    async settle(ms = 300) {
      await new Promise((r) => setTimeout(r, ms));
    },
  };
  setMailTransport(async (msg) => {
    const { delayMs, fail } = capture.mode;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    // A realistic SMTP failure quotes the recipient and the message, which carries the token.
    if (fail) throw Object.assign(new Error(`550 rejected <${msg.to}>: ${msg.text}`), { code: "EENVELOPE", responseCode: 550 });
    capture.sent.push(msg);
  });
  return capture;
}

/** The token in a COVALink email link (`…/page#token=…`). */
export function linkToken(msg: MailMessage, page: "/reset-password" | "/verify-email"): string {
  const m = new RegExp(`https?://[^\\s"<>]+${page}#token=([^\\s"<>&]+)`).exec(msg.text);
  if (!m) throw new Error(`no ${page} link in message`);
  return decodeURIComponent(m[1]);
}
