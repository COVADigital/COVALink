"use client";

import { useId, useState, type FormEvent } from "react";
import { SUBSCRIBE_PATH } from "@/features/audience/consent";

/**
 * The Subscribe block's form on the public page. It posts the address with the
 * profile and block ids; every accepted request gets the same answer, so the
 * page never reveals whether an address was already on the list. The hidden
 * `website` field is a honeypot. In the editor preview the form is inert.
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
  blockId: string;
  title: string;
  description?: string;
  buttonLabel: string;
  consent: string;
  inert?: boolean;
}) {
  const id = useId();
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
        body: JSON.stringify({ p: profileId, b: blockId, email: email.trim(), hp }),
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
        <div className="pp-subscribe-row">
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
