import { z } from "zod";
import { BLOCK_DEFINITIONS, type BlockConfig, type BlockConfigInput, type BlockType, isBlockType } from "./definitions";

export type Block = {
  [K in BlockType]: { id: string; type: K; version: number; visible: boolean; config: BlockConfig<K> };
}[BlockType];

/** Unvalidated editor-side block (what the user is typing). */
export type DraftBlock = {
  [K in BlockType]: { id: string; type: K; version: number; visible: boolean; config: BlockConfigInput<K> };
}[BlockType];

const envelope = z.object({
  id: z.uuid(),
  type: z.string(),
  version: z.number().int().min(1),
  visible: z.boolean().default(true),
  config: z.unknown(),
});

export type BlockParseResult =
  | { success: true; block: Block }
  | { success: false; id?: string; type?: string; error: z.ZodError | string };

/** A stored config upgraded to the type's current version (identity when already current). */
function migrateConfig(type: BlockType, version: number, config: unknown): unknown {
  const def = BLOCK_DEFINITIONS[type];
  return version < def.version && "migrate" in def && def.migrate ? def.migrate(config, version) : config;
}

/**
 * Validates one block, applying version migrations first. The result is a
 * canonical *view* (schemas may strip unknown keys and fill defaults); it is
 * not a lossless copy of the stored JSON, so writes must not use it to stand
 * in for stored blocks the client didn't edit.
 */
export function parseBlock(raw: unknown): BlockParseResult {
  const env = envelope.safeParse(raw);
  if (!env.success) return { success: false, error: env.error };
  const { id, type, version, visible } = env.data;
  if (!isBlockType(type)) return { success: false, id, type, error: `Unknown block type "${type}"` };
  const def = BLOCK_DEFINITIONS[type];
  if (version > def.version) return { success: false, id, type, error: `Block version ${version} is newer than supported` };
  const minReadable = "minReadableVersion" in def ? def.minReadableVersion : undefined;
  if (minReadable !== undefined && version < minReadable) {
    return { success: false, id, type, error: `Block version ${version} can't be read by this version` };
  }
  const config = migrateConfig(type, version, env.data.config);
  const parsed = def.schema.safeParse(config);
  if (!parsed.success) return { success: false, id, type, error: parsed.error };
  return { success: true, block: { id, type, version: def.version, visible, config: parsed.data } as Block };
}

/** Zod schema for a block, used inside the profile document schema. */
export const blockSchema = z.unknown().transform((raw, ctx): Block => {
  const r = parseBlock(raw);
  if (!r.success) {
    if (typeof r.error === "string") ctx.addIssue({ code: "custom", message: r.error });
    else for (const issue of r.error.issues) ctx.addIssue({ ...issue, path: ["config", ...issue.path] } as never);
    return z.NEVER;
  }
  return r.block;
});

export function createBlock<T extends BlockType>(type: T): DraftBlock {
  const def = BLOCK_DEFINITIONS[type];
  return { id: crypto.randomUUID(), type, version: def.version, visible: true, config: def.defaults() } as DraftBlock;
}
