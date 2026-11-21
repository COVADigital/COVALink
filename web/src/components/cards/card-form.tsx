"use client";

import { Check, Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { useState, useTransition } from "react";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { saveCardAction } from "@/features/cards/actions";
import { CARD_COLORS, cardSchema, cardSvg, cardTextColor, type CardSettings } from "@/features/cards/card";

/** The card style form with a live render of the card beside it. Download uses the saved settings, so it waits for a save. */
export function CardForm({ profileId, saved, displayUrl, qrTarget }: { profileId: string; saved: CardSettings; displayUrl: string; qrTarget: string }) {
  const router = useRouter();
  const [name, setName] = useState(saved.displayName);
  const [color, setColor] = useState<string>(saved.color);
  const [nameError, setNameError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [pending, startTransition] = useTransition();
  const dirty = name !== saved.displayName || color !== saved.color;
  const preview = cardSvg({ displayName: name.trim() || saved.displayName, displayUrl, qrTarget, color });

  function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = cardSchema.safeParse({ ...saved, displayName: name, color });
    setNameError(parsed.success ? undefined : parsed.error.issues.find((i) => i.path[0] === "displayName")?.message);
    if (!parsed.success) return;
    setError(null);
    startTransition(async () => {
      const res = await saveCardAction({ profileId, patch: { displayName: parsed.data.displayName, color: parsed.data.color } }).catch(() => null);
      if (!res?.ok) {
        setNameError(res?.fieldErrors?.displayName?.[0]);
        setError(res?.error ?? "Couldn't reach the server. Check your connection and try again.");
        return;
      }
      setStatus("Card saved.");
      router.refresh();
    });
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,18rem)_1fr] md:items-start">
      {/* eslint-disable-next-line @next/next/no-img-element -- a generated SVG data URL */}
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`}
        alt={`Business card preview: ${name.trim() || saved.displayName}`}
        width={400}
        height={560}
        className="mx-auto h-auto w-full max-w-72 rounded-[1.75rem] shadow-sm"
        data-testid="card-preview"
      />
      <form onSubmit={save} noValidate className="grid gap-5 rounded-cl-lg border border-cl-line bg-cl-surface p-5">
        <div className="grid gap-1">
          <h2 className="text-base font-medium">Card style</h2>
          <p className="text-sm text-cl-ink-2">Pick the name and colour on your card. The QR code opens your page.</p>
        </div>
        <FormField id="card-name" label="Display name" value={name} maxLength={60} error={nameError} onChange={(e) => setName(e.target.value)} />
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">
            <Label asChild>
              <span>Background colour</span>
            </Label>
          </legend>
          <RadioGroupPrimitive.Root value={color} onValueChange={setColor} aria-label="Background colour" className="flex flex-wrap gap-2" data-testid="card-colors">
            {CARD_COLORS.map((c) => (
              <RadioGroupPrimitive.Item
                key={c.hex}
                value={c.hex}
                aria-label={c.name}
                className="grid size-11 place-items-center rounded-full border border-cl-line outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:size-9"
                style={{ backgroundColor: c.hex }}
              >
                <RadioGroupPrimitive.Indicator>
                  <Check aria-hidden="true" className="size-4" style={{ color: cardTextColor(c.hex) }} />
                </RadioGroupPrimitive.Indicator>
              </RadioGroupPrimitive.Item>
            ))}
          </RadioGroupPrimitive.Root>
        </fieldset>
        <FormAlert message={error} />
        <p aria-live="polite" className="sr-only">
          {status}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || !dirty} className="min-h-11 rounded-full sm:min-h-0">
            {pending ? "Saving…" : "Save"}
          </Button>
          {dirty ? (
            <span className="text-sm text-cl-ink-2">Save to download your changes.</span>
          ) : (
            <Button asChild variant="outline" className="min-h-11 rounded-full sm:min-h-0">
              <a href={`/dashboard/profiles/${profileId}/card/download`} download data-testid="card-download">
                <Download aria-hidden="true" />
                Download SVG
              </a>
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
