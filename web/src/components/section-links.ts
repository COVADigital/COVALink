import type { SectionLink } from "./section-nav";

/** Sidebar pages under Profiles and Analytics: the user's own profiles. Plain data, built on the server. */
export function profileLinks(profiles: { id: string; label: string }[], href: (id: string) => string, currentId?: string | null): SectionLink[] {
  return profiles.map((p) => ({ href: href(p.id), label: p.label, current: p.id === currentId }));
}
