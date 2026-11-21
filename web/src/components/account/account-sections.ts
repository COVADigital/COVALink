import type { SectionLink } from "@/components/section-nav";

/** Sections of the account settings page, in page order. */
export const ACCOUNT_SECTIONS = [
  { id: "personal", label: "Personal", icon: "personal" },
  { id: "security", label: "Security", icon: "security" },
  { id: "management", label: "Account management", icon: "management" },
] as const satisfies readonly { id: string; label: string; icon: SectionLink["icon"] }[];

export type AccountSectionId = (typeof ACCOUNT_SECTIONS)[number]["id"];

export const ACCOUNT_LINKS: SectionLink[] = ACCOUNT_SECTIONS.map(({ id, label, icon }) => ({ href: `#${id}`, label, icon }));
