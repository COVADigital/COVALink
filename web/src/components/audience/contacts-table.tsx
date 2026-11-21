"use client";

import { Trash } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { TOUCH } from "@/components/admin/styles";
import { FormAlert } from "@/components/auth/form-field";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deleteContactAction } from "@/features/audience/actions";

export interface ContactRow {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  note: string | null;
  source: "block" | "card";
  status: "pending" | "confirmed";
  /** Already formatted on the server, so the table renders the same everywhere. */
  date: string;
}

/** The profile's contacts with a confirmed delete per row. */
export function ContactsTable({ profileId, contacts }: { profileId: string; contacts: ContactRow[] }) {
  const router = useRouter();
  const [target, setTarget] = useState<ContactRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [pending, startTransition] = useTransition();
  // The dialog has no trigger of its own, so it returns focus to the row's button by hand.
  const returnTo = useRef<HTMLButtonElement | null>(null);

  function remove() {
    if (!target) return;
    const row = target;
    startTransition(async () => {
      const res = await deleteContactAction({ profileId, contactId: row.id }).catch(() => null);
      if (!res?.ok) {
        setError(res?.error ?? "Couldn't reach the server. Check your connection and try again.");
        return;
      }
      returnTo.current = null; // its row is going away
      setTarget(null);
      setAnnounce(`Deleted ${row.email}.`);
      router.refresh();
    });
  }

  return (
    <>
      <div className="overflow-x-auto rounded-cl-lg border border-cl-line bg-cl-surface">
        <table className="w-full text-sm" data-testid="audience-contacts">
          <caption className="sr-only">Contacts</caption>
          <thead className="border-b border-cl-line text-left text-xs text-cl-ink-2">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Email</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Phone</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Note</th>
              <th scope="col" className="px-4 py-2.5 font-medium">From</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Date</th>
              <th scope="col" className="w-12 px-2 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cl-line">
            {contacts.map((c) => (
              <tr key={c.id}>
                <td className="max-w-64 truncate px-4 py-2 font-medium" title={c.email}>{c.email}</td>
                <td className="max-w-48 truncate px-4 py-2" title={c.name ?? undefined}>{c.name ?? <span className="text-cl-ink-2">—</span>}</td>
                <td className="whitespace-nowrap px-4 py-2">{c.phone ?? <span className="text-cl-ink-2">—</span>}</td>
                <td className="max-w-56 truncate px-4 py-2" title={c.note ?? undefined}>{c.note ?? <span className="text-cl-ink-2">—</span>}</td>
                <td className="whitespace-nowrap px-4 py-2 text-cl-ink-2">{c.source === "card" ? "Business card" : "Subscribe block"}</td>
                <td className="px-4 py-2">
                  {c.status === "confirmed" ? (
                    <span className="rounded-full bg-cl-ok-wash px-2 py-0.5 text-xs text-cl-ok">Confirmed</span>
                  ) : (
                    <span className="text-xs text-cl-ink-2">Pending · expires within 48 h</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-cl-ink-2">{c.date}</td>
                <td className="px-2 py-1 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 rounded-full sm:size-9"
                    aria-label={`Delete ${c.email}`}
                    onClick={(e) => {
                      returnTo.current = e.currentTarget;
                      setError(null);
                      setTarget(c);
                    }}
                  >
                    <Trash aria-hidden="true" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AlertDialog open={target !== null} onOpenChange={(open) => !open && !pending && setTarget(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            if (!returnTo.current?.isConnected) return;
            e.preventDefault();
            returnTo.current.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {target?.email}?</AlertDialogTitle>
            <AlertDialogDescription>The contact is removed from this list for good. They can sign up again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <FormAlert message={error} />
          <AlertDialogFooter>
            <AlertDialogCancel className={`rounded-full ${TOUCH}`} disabled={pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" className={`rounded-full ${TOUCH}`} disabled={pending} onClick={remove}>
              {pending ? "Deleting…" : "Delete contact"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <p role="status" className="sr-only">{announce}</p>
    </>
  );
}
