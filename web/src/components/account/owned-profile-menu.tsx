"use client";

import { AtSign, ChartLine, Ellipsis, PencilLine } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChangeHandleDialog } from "./change-handle-dialog";

/** The ⋯ menu on an owned profile: change its handle, or open its editor or analytics. */
export function OwnedProfileMenu({
  id,
  label,
  handle,
}: {
  id: string;
  label: string;
  handle: string;
}) {
  const [changing, setChanging] = useState(false);
  const [announce, setAnnounce] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const item = "min-h-11 ed-lg:min-h-9";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 rounded-full sm:size-9"
            aria-label={`Actions for ${label}`}
          >
            <Ellipsis aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem className={item} onSelect={() => setChanging(true)}>
            <AtSign aria-hidden="true" />
            Change handle
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className={item}>
            <Link href={`/dashboard/profiles/${id}`}>
              <PencilLine aria-hidden="true" />
              Edit profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={item}>
            <Link href={`/dashboard/profiles/${id}/analytics`}>
              <ChartLine aria-hidden="true" />
              Analytics
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {changing && (
        <ChangeHandleDialog
          open
          onOpenChange={(next) => {
            setChanging(next);
            // Opened from a menu item that is gone by now, so focus goes back to the ⋯ button.
            if (!next) requestAnimationFrame(() => triggerRef.current?.focus());
          }}
          onChanged={(next) =>
            setAnnounce(`Handle changed. ${label} is now at /${next}.`)
          }
          profileId={id}
          label={label}
          handle={handle}
        />
      )}
      <p role="status" className="sr-only">
        {announce}
      </p>
    </>
  );
}
