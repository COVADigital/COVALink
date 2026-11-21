"use client";

import { X } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { SubscribeForm } from "@/components/profile/subscribe-form";
import { landingSource } from "@/features/analytics/landing-source";
import { cardConsentText } from "@/features/audience/consent";
import { cardVcardPath } from "@/features/blocks/vcard";

const noSubscription = () => () => {};

/**
 * Shown only to visitors who opened the page from the business card's QR code (`?src=card`): a Save contact button
 * and/or a form to share their name and email with the owner. Nothing is read from the visitor's device; they type or
 * autofill the form and press Send, and the address is confirmed by email like a Subscribe block. It renders nothing
 * on the server, so the cached page is the same for everyone.
 */
export function CardWelcome({ profileId, name, shareBack, saveContact }: { profileId: string; name: string; shareBack: boolean; saveContact: boolean }) {
  // The source is only known in the browser: false on the server and during hydration, then the landing value.
  const fromCard = useSyncExternalStore(noSubscription, () => landingSource() === "card", () => false);
  const [closed, setClosed] = useState(false);
  if (!fromCard || closed || (!shareBack && !saveContact)) return null;
  return (
    <section className="pp-card-welcome" aria-label={`From ${name}'s business card`} data-testid="card-welcome">
      <button type="button" className="pp-card-welcome-close" aria-label="Close" onClick={() => setClosed(true)}>
        <X aria-hidden="true" />
      </button>
      {saveContact && (
        <a className="pp-btn" href={cardVcardPath(profileId)} download data-testid="card-save-contact">
          Save {name}&apos;s contact
        </a>
      )}
      {shareBack && (
        <SubscribeForm profileId={profileId} title={`Share your details with ${name}`} buttonLabel="Send" consent={cardConsentText(name)} />
      )}
    </section>
  );
}
