"use client";

import { ChartLine, LayoutGrid, LogOut, Menu, Monitor, Moon, Shield, Sun, User, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useSignOut } from "@/components/auth/sign-out-button";
import { useColorMode } from "@/components/color-mode";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setColorModeAction } from "@/features/color-mode/actions";
import { parseColorMode, type ColorMode } from "@/features/color-mode/mode";
import type { WorkspaceLink } from "./workspace-links";

export type { WorkspaceLink };

/*
 * Workspace navigation for the editor and the dashboard shell. On desktop a
 * quiet icon rail; below 75rem the same destinations sit in a menu in the top
 * bar.
 */

const ICONS: Record<WorkspaceLink["icon"], LucideIcon> = { profiles: LayoutGrid, analytics: ChartLine, account: User, admin: Shield };

export function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="size-8" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--cl-ink)" />
      <circle cx="13" cy="16" r="5.5" fill="none" stroke="var(--cl-surface)" strokeWidth="2.5" />
      <circle cx="19" cy="16" r="5.5" fill="none" stroke="var(--cl-surface)" strokeWidth="2.5" />
    </svg>
  );
}

const THEMES: { value: ColorMode; label: string; Icon: LucideIcon }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

const railItem =
  "relative grid size-10 place-items-center rounded-cl-md text-cl-ink-2 outline-none hover:bg-cl-inset hover:text-cl-ink focus-visible:ring-2 focus-visible:ring-cl-accent";

/** Desktop icon rail. `current` marks the section the page belongs to, if any. */
export function WorkspaceRail({ links, current }: { links: WorkspaceLink[]; current?: WorkspaceLink["icon"] }) {
  return (
    <nav
      aria-label="Main"
      className="sticky top-0 hidden h-dvh w-16 shrink-0 flex-col items-center gap-1 border-r border-cl-line bg-cl-canvas py-3 ed-lg:flex"
    >
      <Link
        href="/dashboard"
        aria-label="COVALink dashboard"
        className="mb-3 grid size-10 place-items-center rounded-cl-md outline-none focus-visible:ring-2 focus-visible:ring-cl-accent"
      >
        <Mark />
      </Link>
      {links.map((l) => {
        const Icon = ICONS[l.icon];
        const active = l.icon === current;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-label={l.label}
            title={l.label}
            aria-current={active ? "page" : undefined}
            className={`${railItem} ${active ? "bg-cl-inset text-cl-ink before:absolute before:inset-y-2.5 before:-left-3 before:w-0.75 before:rounded-r before:bg-cl-ink" : ""}`}
          >
            <Icon className="size-4" aria-hidden="true" />
          </Link>
        );
      })}
      <div className="mt-auto">
        <WorkspaceMenu links={[]} label="Account menu" />
      </div>
    </nav>
  );
}

/** Below 75rem: every destination plus sign-out. On the rail: sign-out only. */
export function WorkspaceMenu({ links, label = "Workspace menu", className }: { links: WorkspaceLink[]; label?: string; className?: string }) {
  const { signOut, pending, failed } = useSignOut();
  const mode = useColorMode();
  const [themePending, startTransition] = useTransition();
  const [themeFailed, setThemeFailed] = useState(false);
  const chooseTheme = (value: string) =>
    startTransition(async () => {
      setThemeFailed(false);
      try {
        const r = await setColorModeAction(parseColorMode(value));
        if (!r.ok) setThemeFailed(true); // on success Next re-renders the route with the new cookie
      } catch {
        setThemeFailed(true);
      }
    });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className={`size-11 ed-lg:size-10 ${className ?? ""}`} aria-label={label}>
          <Menu aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        {links.length > 0 && (
          <>
            <DropdownMenuLabel>COVALink</DropdownMenuLabel>
            {links.map((l) => {
              const Icon = ICONS[l.icon];
              return (
                <DropdownMenuItem key={l.href} asChild className="min-h-11 ed-lg:min-h-9">
                  <Link href={l.href}>
                    <Icon aria-hidden="true" />
                    {l.label}
                  </Link>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Dashboard theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup aria-label="Dashboard theme" value={mode} onValueChange={chooseTheme}>
          {THEMES.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} disabled={themePending} className="min-h-11 ed-lg:min-h-9" onSelect={(e) => e.preventDefault()}>
              <Icon aria-hidden="true" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {themeFailed && (
          <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
            Couldn&apos;t change the theme. Try again.
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="min-h-11 ed-lg:min-h-9" disabled={pending}
          onSelect={(e) => {
            e.preventDefault(); // stay open so a failure is shown here
            void signOut();
          }}
        >
          <LogOut aria-hidden="true" />
          {pending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
        {failed && (
          <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
            Sign-out failed. Try again.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
