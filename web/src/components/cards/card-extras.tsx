"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { saveCardAction } from "@/features/cards/actions";
import type { CardContact, CardSettings } from "@/features/cards/card";

// Contact fields go as typed; the action validates and normalizes them.
type Patch = { shareBack?: boolean; saveContact?: boolean; contact?: Record<string, string> };

const FIELDS = [
  { key: "firstName", label: "First name", autoComplete: "given-name" },
  { key: "lastName", label: "Last name", autoComplete: "family-name" },
  { key: "organization", label: "Organization", autoComplete: "organization" },
  { key: "jobTitle", label: "Job title", autoComplete: "organization-title" },
  { key: "email", label: "Email", autoComplete: "email", type: "email" },
  { key: "phone", label: "Phone", autoComplete: "tel", type: "tel" },
  { key: "website", label: "Website", autoComplete: "url", type: "url" },
] as const;

type ContactValues = Record<(typeof FIELDS)[number]["key"], string>;

const toValues = (c?: CardContact): ContactValues =>
  Object.fromEntries(FIELDS.map((f) => [f.key, c?.[f.key] ?? ""])) as ContactValues;

/**
 * The card's two extras for visitors who scan it. Switches save at once. Save contact needs contact details, so
 * turning it on without them opens the details form, and saving that form turns it on. Editing the details otherwise
 * keeps the switch as it is.
 */
export function CardExtras({ profileId, saved, shareBackNote }: { profileId: string; saved: CardSettings; shareBackNote?: ReactNode }) {
  const router = useRouter();
  const id = useId();
  const [card, setCard] = useState(saved);
  const [editing, setEditing] = useState(false);
  // Only a form opened from the switch turns Save contact on; editing the details leaves the switch as it is.
  const [turnOn, setTurnOn] = useState(false);
  const edit = (on: boolean) => {
    setTurnOn(on);
    setEditing(true);
  };
  const [values, setValues] = useState(() => toValues(saved.contact));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [pending, startTransition] = useTransition();

  function save(patch: Patch, done: string, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await saveCardAction({ profileId, patch }).catch(() => null);
      if (!res?.ok) {
        setFieldErrors(res?.fieldErrors ?? {});
        setError(res?.error ?? "Couldn't reach the server. Check your connection and try again.");
        return;
      }
      setFieldErrors({});
      setCard(res.data);
      setStatus(done);
      after?.();
      router.refresh();
    });
  }

  function saveContact(e: React.FormEvent) {
    e.preventDefault();
    const contact = { label: "Save contact", ...values };
    const done = turnOn || card.saveContact ? "Contact details saved. Visitors can now save them." : "Contact details saved. Save contact is still off.";
    save({ contact, ...(turnOn && { saveContact: true }) }, done, () => setEditing(false));
  }

  const row = "grid gap-3 rounded-cl-lg border border-cl-line bg-cl-surface p-4";
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-3">
      <h2 id={`${id}-heading`} className="text-base font-medium">
        When someone scans your card
      </h2>
      <p className="text-sm text-cl-ink-2">
        Your page shows these to people who open it from this card&apos;s QR code. That link isn&apos;t secret, so treat anything you turn on here as
        public. Visitors type their own details; nothing is read from their phone.
      </p>

      <div className={row} data-testid="card-row-share">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1 text-sm">
            <label htmlFor={`${id}-share`} className="font-medium">
              Let visitors share their details back
            </label>
            <p id={`${id}-share-hint`} className="text-cl-ink-2">
              A form for their name, email and, if they like, phone number and a note. Each person confirms by email, then appears in
              Audience.
            </p>
          </div>
          <Switch
            id={`${id}-share`}
            checked={card.shareBack}
            disabled={pending}
            aria-describedby={`${id}-share-hint`}
            onCheckedChange={(on) => save({ shareBack: on }, on ? "Sharing details back is on." : "Sharing details back is off.")}
            className="mt-1"
          />
        </div>
        {card.shareBack && shareBackNote}
      </div>

      <div className={row} data-testid="card-row-contact">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1 text-sm">
            <label htmlFor={`${id}-contact`} className="font-medium">
              Let visitors save your contact
            </label>
            <p id={`${id}-contact-hint`} className="text-cl-ink-2">
              A Save contact button that adds your details to their phone. While it&apos;s on, anyone who visits your page can download these details.
            </p>
          </div>
          <Switch
            id={`${id}-contact`}
            checked={card.saveContact}
            disabled={pending}
            aria-describedby={`${id}-contact-hint`}
            onCheckedChange={(on) => {
              if (on && !card.contact) edit(true);
              else save({ saveContact: on }, on ? "Save contact is on." : "Save contact is off.");
            }}
            className="mt-1"
          />
        </div>
        {!editing && (
          <Button type="button" variant="outline" className="min-h-11 w-fit rounded-full sm:min-h-0" onClick={() => edit(false)}>
            {card.contact ? "Edit contact details" : "Add contact details"}
          </Button>
        )}
        {editing && (
          <form onSubmit={saveContact} noValidate className="grid gap-3" aria-label="Contact details">
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <FormField
                  key={f.key}
                  id={`${id}-${f.key}`}
                  label={f.label}
                  type={"type" in f ? f.type : "text"}
                  autoComplete={f.autoComplete}
                  value={values[f.key]}
                  error={fieldErrors[f.key]?.[0]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={pending} className="min-h-11 rounded-full sm:min-h-0">
                {pending ? "Saving…" : turnOn ? "Save and turn on" : "Save"}
              </Button>
              <Button type="button" variant="ghost" className="min-h-11 rounded-full sm:min-h-0" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>

      <FormAlert message={error} />
      <p aria-live="polite" className="sr-only">
        {status}
      </p>
    </section>
  );
}
