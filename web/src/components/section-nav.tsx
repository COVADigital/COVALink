"use client";

import {
  ChartLine,
  ChevronLeft,
  IdCard,
  KeyRound,
  LayoutGrid,
  Shield,
  SlidersHorizontal,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { WorkspaceLink } from "@/components/editor/workspace-links";
import { Mark, WorkspaceMenu } from "@/components/editor/workspace-nav";

/*
 * Sidebars from 75rem. `WorkspaceSidebar` is the expanded dashboard sidebar:
 * every destination with its label, and the current one opened up to show its
 * pages. Account settings swaps it for `SectionRail`, its own sections with a
 * way back. Below 75rem pages show `SectionChips` or keep their own in-page
 * navigation. Links are either pages (`current` marks the
 * open one, aria-current="page") or, when every href is "#id", sections of one
 * page, marked while scrolled into view (aria-current="location").
 */

const ICONS = {
  personal: User,
  security: KeyRound,
  profiles: LayoutGrid,
  management: SlidersHorizontal,
  analytics: ChartLine,
  audience: Users,
  card: IdCard,
  account: User,
  admin: Shield,
} satisfies Record<string, LucideIcon>;

export type SectionIcon = keyof typeof ICONS;

export interface SectionLink {
  href: string;
  label: string;
  icon?: SectionIcon;
  /** For page links: the page being shown. */
  current?: boolean;
}

/** In-page sections: the one whose top has passed the top third of the viewport, or the last at the bottom of the page. */
function useScrollSpy(ids: string): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const list = ids ? ids.split(",") : [];
    if (list.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let current = list[0];
      for (const id of list) {
        const el = document.getElementById(id);
        if (el && (atBottom || el.getBoundingClientRect().top <= window.innerHeight / 3)) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ids]);
  return active;
}

/** Which link is current, and the aria-current value it gets. */
function useCurrent(links: SectionLink[]) {
  const spy = links.length > 0 && links.every((l) => l.href.startsWith("#"));
  const active = useScrollSpy(spy ? links.map((l) => l.href.slice(1)).join(",") : "");
  const isCurrent = (l: SectionLink) => (spy ? l.href.slice(1) === (active ?? links[0].href.slice(1)) : !!l.current);
  return { isCurrent, value: spy ? ("location" as const) : ("page" as const) };
}

const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-cl-accent";
const item = `flex min-h-9 min-w-0 items-center gap-2 rounded-cl-md px-2 text-sm ${focusRing}`;
const idle = "text-cl-ink-2 hover:bg-cl-inset hover:text-cl-ink";
const on = "bg-cl-inset font-medium text-cl-ink";

/**
 * The dashboard sidebar for `AppShell`. `current`: the section the page belongs to;
 * `sub`: that section's pages, listed under it (`empty` shows when there are none).
 */
export function WorkspaceSidebar({ links, current, sub = [], empty }: { links: WorkspaceLink[]; current?: WorkspaceLink["icon"]; sub?: SectionLink[]; empty?: string }) {
  const { isCurrent, value } = useCurrent(sub);
  const subCurrent = sub.some(isCurrent);
  return (
    <nav aria-label="Main" className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-1 border-r border-cl-line bg-cl-canvas p-3 ed-lg:flex">
      <Link href="/dashboard" aria-label="COVALink dashboard" className={`mb-3 flex w-fit items-center gap-2 rounded-cl-md pr-2 font-semibold tracking-tight text-cl-ink ${focusRing}`}>
        <Mark />
        COVALink
      </Link>
      <ul className="grid grid-cols-1 gap-0.5 overflow-y-auto">
        {links.map((l) => {
          const Icon = ICONS[l.icon];
          const open = l.icon === current;
          return (
            <li key={l.href}>
              <Link href={l.href} aria-current={open && !subCurrent ? "page" : undefined} className={`${item} ${open ? (subCurrent ? "font-medium text-cl-ink hover:bg-cl-inset" : on) : idle}`}>
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{l.label}</span>
              </Link>
              {open && (sub.length > 0 || empty) && (
                <ul className="mt-0.5 grid grid-cols-1 gap-0.5">
                  {sub.length === 0 && <li className="py-1.5 pl-8 text-sm text-cl-ink-2">{empty}</li>}
                  {sub.map((s) => {
                    const cur = isCurrent(s);
                    return (
                      <li key={s.href}>
                        <Link href={s.href} aria-current={cur ? value : undefined} className={`${item} pl-8 ${cur ? on : idle}`}>
                          <span className="truncate">{s.label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-auto pt-2">
        <WorkspaceMenu links={[]} label="Account menu" />
      </div>
    </nav>
  );
}

/** Account settings' sidebar for `AppShell`'s `nav`. Keeps the account menu (theme and sign-out) at the bottom. */
export function SectionRail({ label, title, links, empty }: { label: string; title: string; links: SectionLink[]; empty?: string }) {
  const { isCurrent, value } = useCurrent(links);
  return (
    <nav aria-label={label} className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-1 border-r border-cl-line bg-cl-canvas p-3 ed-lg:flex">
      <Link href="/dashboard" className={`flex min-h-9 items-center gap-2 rounded-cl-md px-2 text-sm text-cl-ink-2 hover:bg-cl-inset hover:text-cl-ink ${focusRing}`}>
        <ChevronLeft className="size-4" aria-hidden="true" />
        Back to dashboard
      </Link>
      <p className="mt-4 mb-1 px-2 text-xs font-medium text-cl-ink-2">{title}</p>
      {links.length === 0 && empty && <p className="px-2 text-sm text-cl-ink-2">{empty}</p>}
      <ul className="grid grid-cols-1 gap-0.5 overflow-y-auto">
        {links.map((l) => {
          const Icon = l.icon ? ICONS[l.icon] : null;
          const current = isCurrent(l);
          return (
            <li key={l.href}>
              <Link href={l.href} aria-current={current ? value : undefined} className={`${item} ${current ? on : idle}`}>
                {Icon && <Icon className="size-4 shrink-0" aria-hidden="true" />}
                <span className="truncate">{l.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto pt-2">
        <WorkspaceMenu links={[]} label="Account menu" />
      </div>
    </nav>
  );
}

/** Below 75rem: the same links as chips that scroll sideways, stuck to the top of the page. */
export function SectionChips({ label, links }: { label: string; links: SectionLink[] }) {
  const { isCurrent, value } = useCurrent(links);
  return (
    <nav aria-label={label} className="sticky top-0 z-10 border-b border-cl-line bg-cl-canvas ed-lg:hidden">
      <ul className="flex gap-2 overflow-x-auto px-4 py-2 sm:px-6">
        {links.map((l) => {
          const current = isCurrent(l);
          return (
            <li key={l.href} className="shrink-0">
              <Link
                href={l.href}
                aria-current={current ? value : undefined}
                className={`flex min-h-11 items-center rounded-full border px-4 text-sm whitespace-nowrap ${focusRing} ${current ? "border-cl-ink bg-cl-ink text-cl-surface" : "border-cl-line-strong text-cl-ink hover:bg-cl-inset"}`}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
