"use client";

import { useId, useState, type FormEvent } from "react";
import { SUBSCRIBE_PATH } from "@/features/audience/consent";

/**
 * The Subscribe block's form on the public page. It posts the address with the
 * profile and block ids; every accepted request gets the same answer, so the
 * page never reveals whether an address was already on the list. The hidden
 * `website` field is a honeypot. In the editor preview the form is inert.
 * Without a `blockId` it is the business card's share-back form, which also
 * asks for a name and, optionally, a phone number and a note.
 */
export function SubscribeForm({
  profileId,
  blockId,
  title,
  description,
  buttonLabel,
  consent,
  inert = false,
}: {
  profileId?: string;
  /** A Subscribe block's id; without one, the business card's form (name and email). */
  blockId?: string;
  title: string;
  description?: string;
  buttonLabel: string;
  consent: string;
  inert?: boolean;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [email, setEmail] = useState("");
  const [hp, setHp] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error" | "busy">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inert || !profileId || state === "sending") return;
    setState("sending");
    try {
      const res = await fetch(SUBSCRIBE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ p: profileId, ...(blockId ? { b: blockId } : { c: "card", name: name.trim(), phone: phone.trim(), note: note.trim() }), email: email.trim(), hp }),
        credentials: "same-origin",
        cache: "no-store",
      });
      setState(res.status === 202 ? "done" : res.status === 429 ? "busy" : "error");
    } catch {
      setState("error");
    }
  }

  const status = {
    idle: "",
    sending: "",
    done: "Almost there: check your inbox and open the link to confirm.",
    busy: "Too many sign-ups right now. Try again in a few minutes.",
    error: "That didn't work. Check the address and try again.",
  }[state];

  return (
    <form className="pp-subscribe" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <p className="pp-subscribe-title" id={`${id}-title`}>
        {title}
      </p>
      {description && <p className="pp-subscribe-note">{description}</p>}
      {state === "done" ? null : (
        <div className={blockId ? "pp-subscribe-row" : "pp-subscribe-row pp-subscribe-stack"}>
          {!blockId && (
            <>
              <label htmlFor={`${id}-name`} className="sr-only">
                Your name
              </label>
              <input
                id={`${id}-name`}
                className="pp-subscribe-input"
                name="name"
                required
                maxLength={100}
                autoComplete="name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={inert}
                aria-describedby={`${id}-consent ${id}-status`}
              />
            </>
          )}
          <label htmlFor={`${id}-email`} className="sr-only">
            Email address
          </label>
          <input
            id={`${id}-email`}
            className="pp-subscribe-input"
            type="email"
            name="email"
            required
            maxLength={254}
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={inert}
            aria-describedby={`${id}-consent ${id}-status`}
          />
          {!blockId && (
            <>
              <label htmlFor={`${id}-phone`} className="sr-only">
                Phone number (optional)
              </label>
              <input
                id={`${id}-phone`}
                className="pp-subscribe-input"
                type="tel"
                name="phone"
                maxLength={32}
                autoComplete="tel"
                placeholder="Phone number (optional)"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={inert}
              />
              <label htmlFor={`${id}-note`} className="sr-only">
                Note (optional)
              </label>
              <textarea
                id={`${id}-note`}
                className="pp-subscribe-input pp-subscribe-note-input"
                name="note"
                maxLength={500}
                rows={3}
                placeholder="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={inert}
              />
            </>
          )}
          <div className="pp-subscribe-hp" aria-hidden="true">
            <label htmlFor={`${id}-website`}>Website</label>
            <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} />
          </div>
          <button type="submit" className="pp-btn" disabled={inert || state === "sending"}>
            {state === "sending" ? "Sending…" : buttonLabel}
          </button>
        </div>
      )}
      {state !== "done" && (
        <p className="pp-subscribe-note" id={`${id}-consent`}>
          {consent}
        </p>
      )}
      <p className="pp-subscribe-status" id={`${id}-status`} role="status">
        {status}
      </p>
    </form>
  );
}
