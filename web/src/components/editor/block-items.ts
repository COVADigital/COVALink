import type { ViewBlock } from "@/components/profile/blocks";
import type { Block } from "@/features/blocks/block";
import { BLOCK_DEFINITIONS, BLOCK_INPUT_SCHEMAS, isEditableBlockType, type EditableBlockType } from "@/features/blocks/definitions";
import { issueField, type BlockInput } from "@/features/blocks/input";
import { getSocialPlatform } from "@/features/blocks/social-platforms";
import { contactDisplayName } from "@/features/blocks/vcard";

/**
 * Editor-side block list state (client-safe, no React). Blocks hold raw form
 * strings until saved. A stored block of a type this version can't edit is
 * withheld: it protects its draft, so saving is off.
 * A social block's items are `rows`: raw strings plus a client-only
 * `key` for React and focus, which is never sent. An image block also
 * holds the chosen asset's `width`/`height` for the preview; they are never
 * sent either, because the server stamps them.
 */

export type FieldValues = Record<string, string>;
export type SocialRow = { key: string; platform: string; url: string };
export type EditableItem = {
  id: string;
  type: EditableBlockType;
  visible: boolean;
  values: FieldValues;
  rows?: SocialRow[];
};

export type ItemValidation = { ok: true; block: Block } | { ok: false; fields: Record<string, string[]>; message?: string };

/** RFC 4122 v4 id; falls back to getRandomValues where randomUUID needs a secure context. */
export function newBlockId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Scalar fields as form strings; a list (social `items`) is held as rows instead. */
function toValues(config: object): FieldValues {
  const out: FieldValues = {};
  for (const [k, v] of Object.entries(config)) {
    if (Array.isArray(v)) continue;
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

const toRows = (items: readonly { platform: string; url: string }[]): SocialRow[] =>
  items.map((i) => ({ key: newBlockId(), platform: i.platform, url: i.url }));

function initialRows(type: EditableBlockType, config: object): SocialRow[] | undefined {
  if (type !== "social") return undefined;
  const items = (config as { items?: unknown }).items;
  return Array.isArray(items) ? toRows(items as { platform: string; url: string }[]) : [];
}

/** Every field of the type is present (defaults first), so unsaved-change detection is stable. */
export function toEditorItems(blocks: readonly Block[]): EditableItem[] {
  return blocks.flatMap((b): EditableItem[] =>
    isEditableBlockType(b.type)
      ? [
          {
            id: b.id,
            type: b.type,
            visible: b.visible,
            values: { ...toValues(BLOCK_DEFINITIONS[b.type].defaults()), ...toValues(b.config) },
            ...(b.type === "social" ? { rows: initialRows(b.type, b.config) } : {}),
          },
        ]
      : [],
  );
}

export function createItem(type: EditableBlockType): EditableItem {
  const defaults = BLOCK_DEFINITIONS[type].defaults();
  const rows = initialRows(type, defaults);
  return { id: newBlockId(), type, visible: true, values: toValues(defaults), ...(rows ? { rows } : {}) };
}

export function duplicateItem(item: EditableItem): EditableItem {
  return { ...item, id: newBlockId(), values: { ...item.values }, ...(item.rows ? { rows: toRows(item.rows) } : {}) };
}

/** A new, empty social row (the first registry platform, no address). */
export function newSocialRow(): SocialRow {
  return toRows([{ platform: (BLOCK_DEFINITIONS.social.defaults().items[0] as { platform: string }).platform, url: "" }])[0];
}

/**
 * The config the item would submit: its form values, plus a social block's
 * rows without their keys. An image block sends its boolean and never its
 * dimensions.
 */
export function itemConfig(item: EditableItem): Record<string, unknown> {
  if (item.type === "image") {
    const { src = "", alt = "", decorative, caption = "", href = "", aspect = "auto" } = item.values;
    return { src, alt, decorative: decorative === "true", caption, href, aspect };
  }
  return item.rows ? { ...item.values, items: item.rows.map(({ platform, url }) => ({ platform, url })) } : item.values;
}

const issueFields = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) => {
  const fields: Record<string, string[]> = {};
  let message: string | undefined;
  for (const issue of issues) {
    // Same keys as the server: `url`, or `items.2.url` inside the social list.
    const key = issueField(issue.path);
    if (key !== undefined) (fields[key] ??= []).push(issue.message);
    else message = issue.message;
  }
  return { fields, message };
};

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Same rules as the server (`BLOCK_INPUT_SCHEMAS`), for inline errors and the preview. */
export function validateItem(item: EditableItem): ItemValidation {
  const r = BLOCK_INPUT_SCHEMAS[item.type].safeParse(itemConfig(item));
  if (!r.success) return { ok: false, ...issueFields(r.error.issues) };
  const def = BLOCK_DEFINITIONS[item.type];
  let config: unknown = r.data;
  if (item.type === "image") {
    // The preview uses the size the picker reported; the server stamps its own.
    const sized = def.schema.safeParse({ ...r.data, width: Number(item.values.width), height: Number(item.values.height) });
    if (!sized.success) return { ok: false, fields: { src: ["Choose or upload an image"] } };
    config = sized.data;
  }
  return { ok: true, block: { id: item.id, type: item.type, version: def.version, visible: item.visible, config } as Block };
}

export function toBlockInput(items: readonly EditableItem[]): BlockInput[] {
  return items.map((i) => ({ id: i.id, type: i.type, visible: i.visible, config: itemConfig(i) }));
}

/** Blocks for the shared preview renderer: invalid blocks become placeholders. */
export function toViewBlocks(items: readonly EditableItem[]): ViewBlock[] {
  return items.map((i): ViewBlock => {
    const v = validateItem(i);
    return v.ok ? v.block : { id: i.id, type: i.type, visible: i.visible, incomplete: true };
  });
}

/** Short, human name for a block, used in control labels and announcements. */
export function itemLabel(item: EditableItem): string {
  const pick = (s: string | undefined, fallback: string) => {
    const t = (s ?? "").trim().split("\n")[0];
    return t ? (t.length > 40 ? `${t.slice(0, 39)}…` : t) : fallback;
  };
  switch (item.type) {
    case "link":
      return pick(item.values.title, "Untitled link");
    case "heading":
      return pick(item.values.text, "Untitled heading");
    case "text":
      return pick(item.values.markdown, "Empty text");
    case "divider":
      return "Divider";
    case "social": {
      const names = (item.rows ?? []).map((r) => getSocialPlatform(r.platform)?.label ?? r.platform);
      return pick(names.join(", "), "No social links");
    }
    case "email":
      return pick(item.values.label, "Email button");
    case "phone":
      return pick(item.values.label, "Phone button");
    case "contact":
      return pick(contactDisplayName(item.values), "Contact card");
    case "spacer":
      return `Spacer (${SPACER_SIZES[item.values.size] ?? "medium"})`;
    case "image":
      return pick(item.values.alt || item.values.caption, item.values.decorative === "true" ? "Decorative image" : "Untitled image");
    case "video":
      return pick(item.values.title, "Untitled video");
    case "music":
      return pick(item.values.title, "Untitled music player");
  }
}

export const SPACER_SIZES: Record<string, string> = { xs: "extra small", sm: "small", md: "medium", lg: "large", xl: "extra large" };

/** Uploaded images chosen in image blocks (saved or not); the library won't delete them. */
export const imageSources = (items: readonly EditableItem[]) => items.flatMap((i) => (i.type === "image" && i.values.src ? [i.values.src] : []));

/** Short platform name of a social row, for control labels and announcements. */
export const rowLabel = (row: SocialRow) => getSocialPlatform(row.platform)?.label ?? "link";

/** Stable serialization of what would be saved, for unsaved-change detection. */
export function serializeItems(items: readonly EditableItem[]): string {
  return JSON.stringify(toBlockInput(items));
}
