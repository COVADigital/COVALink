"use client";

import { useEffect, useRef, useState } from "react";
import { TOUCH } from "@/components/admin/styles";
import { Button } from "@/components/ui/button";
import { ChangePasswordForm } from "./change-password-form";

/** The password row: a short description, and the change form opened in place on request. */
export function PasswordRow() {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);

  useEffect(() => {
    if (open) document.getElementById("currentPassword")?.focus();
    else if (opened.current) toggleRef.current?.focus();
    opened.current = open;
  }, [open]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-medium">Password</h3>
          <p className="text-sm text-cl-ink-2">Change the password you sign in with. You can sign out your other devices at the same time.</p>
        </div>
        <Button
          ref={toggleRef}
          type="button"
          variant="outline"
          className={`rounded-full ${TOUCH}`}
          aria-expanded={open}
          aria-controls="change-password"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Cancel" : "Change password"}
        </Button>
      </div>
      <div id="change-password" hidden={!open} className="border-t border-cl-line pt-4">
        {open && <ChangePasswordForm />}
      </div>
    </div>
  );
}
