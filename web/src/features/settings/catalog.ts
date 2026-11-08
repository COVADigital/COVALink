/**
 * Client-safe descriptions of the installation settings for the admin forms.
 * The server schemas in `service.ts` remain the authority; a
 * unit test proves these bounds match them.
 */

export type SettingKind = "boolean" | "integer" | "text";

export interface SettingSpec {
  key: string;
  group: "site" | "registration" | "limits";
  label: string;
  description: string;
  kind: SettingKind;
  min?: number;
  max?: number;
  maxLength?: number;
  unit?: string;
  /** Security setting: only the super administrator can change it. */
  security: boolean;
}

export const SETTING_SPECS = [
  {
    key: "site.name",
    group: "site",
    label: "Site name",
    description: "Shown in page titles and the default profile description.",
    kind: "text",
    maxLength: 60,
    security: false,
  },
  {
    key: "registration.enabled",
    group: "registration",
    label: "Public sign-up",
    description: "Allow anyone to create an account at /register.",
    kind: "boolean",
    security: true,
  },
  {
    key: "registration.inviteOnly",
    group: "registration",
    label: "Invite-only registration",
    description:
      "Invitations aren't available yet, so turning this on closes registration completely: nobody can create an account, even with public sign-up on.",
    kind: "boolean",
    security: true,
  },
  {
    key: "profiles.maxPerUser",
    group: "limits",
    label: "Profiles per account",
    description: "How many profiles each account can create. Existing profiles are kept when lowered.",
    kind: "integer",
    min: 1,
    max: 100,
    security: false,
  },
  {
    key: "media.quotaMb",
    group: "limits",
    label: "Image storage per account",
    description: "Uploads stop once an account's images reach this size.",
    kind: "integer",
    min: 1,
    max: 10240,
    unit: "MB",
    security: false,
  },
  {
    key: "media.uploadsPerHour",
    group: "limits",
    label: "Image uploads per hour",
    description: "Upload attempts allowed per account in each clock hour.",
    kind: "integer",
    min: 1,
    max: 1000,
    security: false,
  },
  {
    key: "analytics.retentionDays",
    group: "limits",
    label: "Analytics retention",
    description: "Older views and clicks are deleted when the operator runs analytics:purge (it isn't scheduled by COVALink).",
    kind: "integer",
    min: 1,
    max: 3650,
    unit: "days",
    security: false,
  },
] as const satisfies readonly SettingSpec[];

export type CatalogKey = (typeof SETTING_SPECS)[number]["key"];

export const SETTING_GROUPS = [
  { id: "site", title: "Site" },
  { id: "registration", title: "Registration" },
  { id: "limits", title: "Limits and retention" },
] as const;

export function settingSpec(key: string): SettingSpec | undefined {
  return SETTING_SPECS.find((s) => s.key === key);
}
