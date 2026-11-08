import { z } from "zod";
import type { BlockListErrors } from "@/lib/errors";
import { parseBlock, type Block } from "./block";
import { BLOCK_DEFINITIONS, BLOCK_INPUT_SCHEMAS, isEditableBlockType, type EditableBlockType } from "./definitions";

/**
 * Client block-list contract. A client sends the
 * complete ordered list of editable blocks `{id, type, visible, config}` (no
 * `version`: the server stamps it). Order is array position. An entry left out
 * is deleted, which is safe because a draft holding anything the editor doesn't
 * receive is refused before the list is read (`protectedCount`).
 */

export const MAX_BLOCKS = 100;

const blockEnvelope = z.object({ id: z.string(), type: z.string(), visible: z.boolean(), config: z.unknown() }).strict();
const uuid = z.uuid();
const ENVELOPE_KEYS = new Set(["id", "type", "version", "visible", "config"]);

export type BlockInput = { id: string; type: EditableBlockType; visible: boolean; config: unknown };

/** A readable stored draft block: its exact stored JSON and its parsed view. */
export interface StoredBlock {
  raw: unknown;
  block: Block;
}

export interface StoredBlocks {
  /** Readable, editable blocks of the stored draft, by id. */
  draft: ReadonlyMap<string, StoredBlock>;
  /** Type of every id in the stored draft or published snapshot, valid or not. */
  knownTypes: ReadonlyMap<string, string>;
  /** Stored draft blocks that don't parse (unknown type, newer version, bad config). */
  unreadable: number;
  /** Editable-type draft blocks carrying stored fields the editor can't round-trip. */
  lossy: number;
  /** Readable draft blocks of a registered type outside `EDITABLE_BLOCK_TYPES`, which the editor never receives. */
  nonEditable: number;
  /** Stored draft blocks beyond MAX_BLOCKS, which the editor never receives. */
  overflow: number;
  /**
   * Draft blocks this version can't rewrite without losing data
   * (unreadable + lossy + nonEditable + overflow). While > 0 every draft write is refused.
   */
  protectedCount: number;
}

/**
 * True when the editor can carry everything stored in an editable-type block:
 * no envelope keys beyond the contract, and every stored config key survives
 * parsing, except fields an older version retired on purpose
 * (`retiredFields`, dropped by `migrate`). Defaults the schema adds and
 * normalized values (trimmed text, canonical URLs, a blank optional field
 * becoming `undefined`) are not losses; a stripped key is, whatever its value.
 * Zod keeps a recognized key as an own property of the output even
 * when it transforms to `undefined`, and omits a stripped one.
 */
function editorCanCarry(raw: unknown, block: Block): boolean {
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !ENVELOPE_KEYS.has(k))) return false;
  if (!r.config || typeof r.config !== "object") return false;
  const def: { version: number; retiredFields?: readonly string[] } = BLOCK_DEFINITIONS[block.type];
  const retired = (r.version as number) < def.version ? (def.retiredFields ?? []) : [];
  const parsed = block.config as Record<string, unknown>;
  return Object.keys(r.config).every((k) => Object.hasOwn(parsed, k) || retired.includes(k));
}

export function assessStoredBlocks(draftBlocks: unknown, publishedBlocks: unknown): StoredBlocks {
  const draft = new Map<string, StoredBlock>();
  const knownTypes = new Map<string, string>();
  let unreadable = 0;
  let lossy = 0;
  let nonEditable = 0;
  for (const list of [publishedBlocks, draftBlocks]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const r = raw as { id?: unknown; type?: unknown } | null;
      if (r && typeof r.id === "string" && typeof r.type === "string") knownTypes.set(r.id, r.type);
    }
  }
  const list = Array.isArray(draftBlocks) ? draftBlocks : [];
  for (const raw of list) {
    const parsed = parseBlock(raw);
    if (!parsed.success) {
      unreadable++;
      continue;
    }
    if (!isEditableBlockType(parsed.block.type)) {
      nonEditable++;
      continue;
    }
    if (!editorCanCarry(raw, parsed.block)) lossy++;
    draft.set(parsed.block.id, { raw, block: parsed.block });
  }
  const overflow = Math.max(0, list.length - MAX_BLOCKS);
  return { draft, knownTypes, unreadable, lossy, nonEditable, overflow, protectedCount: unreadable + lossy + nonEditable + overflow };
}

/** A field key for an issue path: `title`, or `items.2.url` inside a list. */
export const issueField = (path: readonly PropertyKey[]) => (path.length ? path.map(String).join(".") : undefined);

/** Maps config validation issues to `{field: messages}`; issues on the object itself go to `message`. */
function configProblems(error: z.ZodError): { message?: string; fields?: Record<string, string[]> } {
  const fields: Record<string, string[]> = {};
  let message: string | undefined;
  for (const issue of error.issues) {
    const key = issueField(issue.path);
    if (issue.code === "unrecognized_keys" || key === undefined) {
      message = issue.code === "unrecognized_keys" ? "This block has fields that aren't supported." : issue.message;
    } else {
      (fields[key] ??= []).push(issue.message);
    }
  }
  return { ...(message ? { message } : {}), ...(Object.keys(fields).length ? { fields } : {}) };
}

/**
 * The stored size of an uploaded image an image block may use, or why it may
 * not. Supplied by the server from the locked asset row; the
 * client never supplies dimensions.
 */
export type ImageMediaLookup = (src: string) => { width: number; height: number } | { error: string };

export const IMAGE_NOT_IN_LIBRARY = "This image isn't in your library any more. Choose another image.";

/** `blocks` is the parsed view (for whole-document validation and responses); `write` is what to store, in the same order. */
export type ResolveResult = { ok: true; blocks: Block[]; write: unknown[] } | { ok: false; errors: BlockListErrors };

/**
 * Validates a client block list against the stored blocks. Never trusts client
 * versions, ids or types beyond what is checked here; the caller re-validates
 * the whole merged document. An image block's dimensions come from `images`
 * and the stamped config is parsed again with the stored schema;
 * without a lookup no image block can be written.
 */
export function resolveBlockList(input: unknown, stored: StoredBlocks, images?: ImageMediaLookup): ResolveResult {
  if (!Array.isArray(input)) return { ok: false, errors: { list: ["Blocks must be a list."], items: [] } };
  if (input.length > MAX_BLOCKS) {
    return { ok: false, errors: { list: [`A profile can have at most ${MAX_BLOCKS} blocks.`], items: [] } };
  }

  const items: BlockListErrors["items"] = [];
  const blocks: Block[] = [];
  const write: unknown[] = [];
  const seen = new Set<string>();

  input.forEach((raw, index) => {
    const env = blockEnvelope.safeParse(raw);
    if (!env.success) return items.push({ index, message: "This block is malformed." });

    const { id, type, visible, config } = env.data;
    if (!uuid.safeParse(id).success) return items.push({ index, message: "This block has an invalid id." });
    if (seen.has(id)) return items.push({ index, message: "Two blocks share the same id." });
    seen.add(id);

    if (!isEditableBlockType(type)) return items.push({ index, id, message: "This kind of block can't be created or edited yet." });
    const knownType = stored.knownTypes.get(id);
    if (knownType !== undefined && knownType !== type) return items.push({ index, id, message: "A block can't change its type." });

    const parsed = BLOCK_INPUT_SCHEMAS[type].safeParse(config);
    if (!parsed.success) return items.push({ index, id, ...configProblems(parsed.error) });
    let canonical: unknown = parsed.data;
    if (type === "image") {
      const image = parsed.data as { src: string };
      const size = images?.(image.src) ?? { error: IMAGE_NOT_IN_LIBRARY };
      if ("error" in size) return items.push({ index, id, fields: { src: [size.error] } });
      const stamped = BLOCK_DEFINITIONS.image.schema.safeParse({ ...image, width: size.width, height: size.height });
      if (!stamped.success) return items.push({ index, id, ...configProblems(stamped.error) });
      canonical = stamped.data;
    }
    const block = { id, type, version: BLOCK_DEFINITIONS[type].version, visible, config: canonical } as Block;
    blocks.push(block);
    write.push(block);
  });

  return items.length ? { ok: false, errors: { list: [], items } } : { ok: true, blocks, write };
}
