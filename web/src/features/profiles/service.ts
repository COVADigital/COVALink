import "server-only";
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { profiles, users } from "@/db/schema";
import { getSetting } from "@/features/settings/service";
import { AppError, isUniqueViolation } from "@/lib/errors";
import { assessStoredBlocks, resolveBlockList, type ImageMediaLookup } from "@/features/blocks/input";
import { AVATAR_PATH, BACKGROUND_PATH } from "@/features/media/references";
import { assertExternalAvatar, assertMediaReferences, lockImageSizes, type ReferenceScope } from "@/features/media/service";
import { contrastFieldErrors, themeContrastIssues } from "@/features/themes/contrast";
import { themeInputSchema } from "@/features/themes/schema";
import { assessStoredTheme, canonicalTheme, DEFAULT_THEME, presetTheme, type StoredTheme } from "@/features/themes/theme";
import { createDefaultDocument, profileDocumentSchema, readDocument, type ProfileDocument } from "./document";
import { handleSchema } from "./handle";
import { draftPatchSchema, revisionSchema, type DraftPatch } from "./draft-input";

/**
 * All dashboard profile reads/writes go through this module. Every function
 * takes the acting user's id and scopes queries by `owner_id`, so guessing
 * another profile's id yields NOT_FOUND. Draft writes use optimistic
 * concurrency (`draft_revision`). Cache invalidation is done by the
 * caller (actions), which receives the affected handles.
 */

export const createProfileInput = z
  .object({
    handle: handleSchema,
    label: z.string().trim().min(1, "Give this profile a name").max(40),
    displayName: z.string().trim().min(1, "Add a display name").max(60),
  })
  .strict();

export const updateProfileMetaInput = z
  .object({
    handle: handleSchema,
    label: z.string().trim().min(1, "Give this profile a name").max(40),
  })
  .strict();

const saveDraftInput = z.object({ expectedRevision: revisionSchema, patch: draftPatchSchema }).strict();
const publishInput = z.object({ expectedRevision: revisionSchema, patch: draftPatchSchema.optional() }).strict();
const revertInput = z.object({ expectedRevision: revisionSchema }).strict();

export interface ProfileSummary {
  id: string;
  handle: string;
  label: string;
  isPublished: boolean;
  everPublished: boolean;
  publishedAt: Date | null;
  hasUnpublishedChanges: boolean;
  updatedAt: Date;
}

const STALE_MESSAGE = "This profile was changed somewhere else (another tab or device). Reload to get the latest version.";

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError("Please fix the highlighted fields.", "VALIDATION", z.flattenError(r.error).fieldErrors as Record<string, string[]>);
  }
  return r.data;
}

function hasUnpublishedChanges(row: { draftRevision: number; publishedRevision: number | null }): boolean {
  return row.publishedRevision === null || row.draftRevision !== row.publishedRevision;
}

export async function listProfiles(ownerId: string): Promise<ProfileSummary[]> {
  const rows = await db
    .select({
      id: profiles.id,
      handle: profiles.handle,
      label: profiles.label,
      isPublished: profiles.isPublished,
      publishedAt: profiles.publishedAt,
      draftRevision: profiles.draftRevision,
      publishedRevision: profiles.publishedRevision,
      updatedAt: profiles.updatedAt,
    })
    .from(profiles)
    .where(eq(profiles.ownerId, ownerId))
    .orderBy(asc(profiles.createdAt));
  return rows.map(({ draftRevision, publishedRevision, ...r }) => ({
    ...r,
    everPublished: publishedRevision !== null,
    hasUnpublishedChanges: hasUnpublishedChanges({ draftRevision, publishedRevision }),
  }));
}

export async function getOwnedProfile(ownerId: string, profileId: string) {
  if (!z.uuid().safeParse(profileId).success) throw new AppError("Profile not found", "NOT_FOUND");
  const row = await db.query.profiles.findFirst({
    where: and(eq(profiles.id, profileId), eq(profiles.ownerId, ownerId)),
  });
  if (!row) throw new AppError("Profile not found", "NOT_FOUND");
  const { doc: draft } = readDocument(row.draft, row.label);
  const protectedBlocks = assessStoredBlocks((row.draft as { blocks?: unknown } | null)?.blocks, undefined).protectedCount;
  const { status, reasons } = assessStoredTheme((row.draft as { theme?: unknown } | null)?.theme);
  return {
    id: row.id,
    handle: row.handle,
    label: row.label,
    verified: row.verified,
    isPublished: row.isPublished,
    publishedAt: row.publishedAt,
    draftRevision: row.draftRevision,
    publishedRevision: row.publishedRevision,
    draftUpdatedAt: row.draftUpdatedAt,
    draft,
    /**
     * Stored draft blocks this version can't rewrite losslessly (unreadable,
     * carrying fields the editor can't round-trip, or beyond 100). While > 0
     * the draft can't be saved or published.
     */
    protectedBlocks,
    /**
     * Whether the appearance editor can change the stored draft theme:
     * `editable`, `locked` (valid but not round-trippable) or `invalid`
     * (unreadable; `draft.theme` is then the default and publishing is blocked).
     */
    appearance: { status, reasons },
    hasUnpublishedChanges: hasUnpublishedChanges(row),
  };
}

export type OwnedProfile = Awaited<ReturnType<typeof getOwnedProfile>>;

export async function createProfile(ownerId: string, input: unknown) {
  const data = parseOrThrow(createProfileInput, input);
  const max = await getSetting("profiles.maxPerUser");
  try {
    return await db.transaction(async (tx) => {
      // Lock the owner row so concurrent creates can't both pass the limit check.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");
      const [{ total }] = await tx.select({ total: count() }).from(profiles).where(eq(profiles.ownerId, ownerId));
      if (total >= max) throw new AppError(`You can have at most ${max} profiles.`, "LIMIT");
      const [row] = await tx
        .insert(profiles)
        .values({ ownerId, handle: data.handle, label: data.label, draft: createDefaultDocument(data.displayName) })
        .returning({ id: profiles.id, handle: profiles.handle });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("That handle is taken.", "CONFLICT", { handle: ["That handle is taken"] });
    throw err;
  }
}

export async function updateProfileMeta(ownerId: string, profileId: string, input: unknown) {
  const data = parseOrThrow(updateProfileMetaInput, input);
  const current = await getOwnedProfile(ownerId, profileId);
  try {
    await db
      .update(profiles)
      .set({ handle: data.handle, label: data.label })
      .where(and(eq(profiles.id, profileId), eq(profiles.ownerId, ownerId)));
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("That handle is taken.", "CONFLICT", { handle: ["That handle is taken"] });
    throw err;
  }
  return { id: profileId, previousHandle: current.handle, handle: data.handle };
}

/** Locks the caller's profile row for the rest of the transaction. */
async function lockOwned(tx: Tx, ownerId: string, profileId: string) {
  if (!z.uuid().safeParse(profileId).success) throw new AppError("Profile not found", "NOT_FOUND");
  const [row] = await tx
    .select({
      id: profiles.id,
      handle: profiles.handle,
      label: profiles.label,
      draft: profiles.draft,
      published: profiles.published,
      draftRevision: profiles.draftRevision,
      publishedAt: profiles.publishedAt,
    })
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.ownerId, ownerId)))
    .for("update");
  if (!row) throw new AppError("Profile not found", "NOT_FOUND");
  return row;
}

function assertRevision(actual: number, expected: number) {
  if (actual !== expected) throw new AppError(STALE_MESSAGE, "CONFLICT");
}

const PROTECTED_MESSAGE =
  "This draft contains blocks this version of COVALink can't edit without losing data. To protect them, it can't be changed here. Discarding draft changes restores the published version.";
const THEME_LOCKED_MESSAGE =
  "Your saved appearance can't be edited here without losing parts of it. Replace the saved appearance to change it.";
const THEME_UNREADABLE_MESSAGE =
  "Your saved appearance can't be read, so this profile can't be published. Replace the saved appearance first.";
const CONTRAST_MESSAGE = "This appearance doesn't have enough contrast to publish. Fix the highlighted colors, then try again.";

const asObject = (v: unknown) => (v && typeof v === "object" ? v : {}) as Record<string, unknown>;

/**
 * `doc` is the validated, parsed view (returned to the editor); `write` is
 * what gets stored: the stored JSON with only the parts the client changed
 * replaced. Stored blocks the client didn't edit, the theme when the client
 * didn't send one, settings other than SEO and unrelated fields are kept
 * exactly as stored. Parsing is a canonical view that can strip unknown keys,
 * so it never stands in for stored data. `theme` classifies
 * the theme being written.
 */
interface MergedDraft {
  doc: ProfileDocument;
  /** Stored JSON, typed as the column; its content was validated through `doc`. */
  write: ProfileDocument;
  theme: StoredTheme;
}

function refuseProtected(storedDraft: unknown, storedPublished: unknown) {
  const stored = assessStoredBlocks(asObject(storedDraft).blocks, asObject(storedPublished).blocks);
  if (stored.protectedCount > 0) throw new AppError(PROTECTED_MESSAGE, "VALIDATION");
  return stored;
}

/** Strict theme input, with problems reported per field as `theme.<path>`. */
function parseThemeInput(input: unknown) {
  const r = themeInputSchema.safeParse(input);
  if (r.success) return r.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of r.error.issues) {
    const key = ["theme", ...issue.path.map(String)].join(".");
    const message =
      issue.code === "unrecognized_keys"
        ? "This setting isn't supported."
        : issue.code === "invalid_type"
          ? "This value isn't valid."
          : issue.message;
    (fieldErrors[key] ??= []).push(message);
  }
  throw new AppError("Some appearance settings need attention.", "VALIDATION", fieldErrors);
}

/**
 * The parsed document for a stored or merged draft. An unreadable theme is
 * kept as stored, so the rest of the document is validated against
 * the default theme instead.
 */
function parseDocument(draft: Record<string, unknown>, theme: StoredTheme, failure: string): ProfileDocument {
  const r = profileDocumentSchema.safeParse({ ...draft, theme: theme.status === "invalid" ? DEFAULT_THEME : draft.theme });
  if (!r.success) throw new AppError(failure, "VALIDATION");
  return r.data;
}

/**
 * Merges a draft patch into the stored draft. Settings other than SEO are
 * taken from the stored JSON, never from the client. Without a block list the
 * stored blocks are kept verbatim; with one, it is resolved against the
 * stored blocks. A draft holding blocks this version can't rewrite
 * losslessly (unreadable, carrying fields the editor can't round-trip, of a
 * type it can't edit, or beyond the 100-block limit) is never rewritten, and
 * that refusal comes before the list is read.
 *
 * Without `theme` the stored theme is kept verbatim, whatever its state. A
 * submitted `theme` replaces it with the server-stamped canonical form, but
 * only when the stored theme is editable; `replaceTheme` (the confirmed
 * replacement) writes a preset over any stored theme. The merged
 * document is re-validated in full first, after image blocks have been
 * stamped with the sizes in `images`.
 */
function mergePatch(storedDraft: unknown, storedPublished: unknown, patch: DraftPatch, images: ImageMediaLookup): MergedDraft {
  const raw = asObject(storedDraft);
  const settings = asObject(raw.settings);
  const stored = refuseProtected(storedDraft, storedPublished);

  let blocks: unknown = raw.blocks;
  if (patch.blocks !== undefined) {
    const resolved = resolveBlockList(patch.blocks, stored, images);
    if (!resolved.ok) throw new AppError("Some blocks need attention.", "VALIDATION", undefined, resolved.errors);
    blocks = resolved.write;
  }

  let themeState = assessStoredTheme(raw.theme);
  let theme: unknown = raw.theme;
  if (patch.replaceTheme !== undefined) {
    theme = presetTheme(patch.replaceTheme);
    themeState = assessStoredTheme(theme);
  } else if (patch.theme !== undefined) {
    if (themeState.status !== "editable") throw new AppError(THEME_LOCKED_MESSAGE, "VALIDATION");
    theme = canonicalTheme(parseThemeInput(patch.theme));
    themeState = assessStoredTheme(theme);
  }

  const merged = { ...raw, header: patch.header, settings: { ...settings, seo: patch.seo }, blocks, theme };
  const doc = parseDocument(merged, themeState, "This profile's saved content is invalid and can't be updated.");
  const write = { ...raw, header: doc.header, settings: { ...settings, seo: doc.settings.seo }, blocks, theme };
  return { doc, write: write as unknown as ProfileDocument, theme: themeState };
}

/** The stored draft, validated for publishing; it is published exactly as stored. */
function storedDocument(storedDraft: unknown): MergedDraft {
  refuseProtected(storedDraft, undefined);
  const raw = asObject(storedDraft);
  const theme = assessStoredTheme(raw.theme);
  const doc = parseDocument(raw, theme, "This profile's saved content is invalid and can't be published.");
  return { doc, write: raw as unknown as ProfileDocument, theme };
}

/**
 * Publishing needs a readable theme with enough contrast. Saving a
 * draft doesn't, and pages already published stay online whatever their
 * stored colors.
 */
function assertPublishable(m: MergedDraft) {
  if (m.theme.status === "invalid") throw new AppError(THEME_UNREADABLE_MESSAGE, "VALIDATION");
  const issues = themeContrastIssues(m.theme.theme);
  if (issues.length) throw new AppError(CONTRAST_MESSAGE, "VALIDATION", contrastFieldErrors(issues));
}

const appearanceOf = (t: StoredTheme) => ({ status: t.status, reasons: t.reasons });

/**
 * Uploaded images in the parts a patch touches must be the owner's, of the
 * right kind: always the avatar; the background when a theme is
 * sent; every reference inside the blocks it submits. Untouched fields are
 * checked when publishing, which covers every reference in the document.
 */
function touchedMedia(patch: DraftPatch): ReferenceScope {
  return ({ path }) => {
    const p = path.join(".");
    if (p === AVATAR_PATH || (patch.theme !== undefined && p === BACKGROUND_PATH)) return true;
    return patch.blocks !== undefined && path[0] === "blocks" && typeof path[1] === "number";
  };
}

/** The `src` of every image block a patch submits (stamped from the locked rows). */
function imageSources(patch: DraftPatch | undefined): string[] {
  return (patch?.blocks ?? []).flatMap((entry) => {
    const e = entry as { type?: unknown; config?: { src?: unknown } } | null;
    return e && e.type === "image" && typeof e.config?.src === "string" ? [e.config.src] : [];
  });
}

export async function saveDraft(ownerId: string, profileId: string, input: unknown) {
  const { expectedRevision, patch } = parseOrThrow(saveDraftInput, input);
  assertExternalAvatar(patch.header.avatarUrl);
  return db.transaction(async (tx) => {
    const row = await lockOwned(tx, ownerId, profileId);
    assertRevision(row.draftRevision, expectedRevision);
    const images = await lockImageSizes(tx, ownerId, imageSources(patch));
    const { doc, write, theme } = mergePatch(row.draft, row.published, patch, images);
    await assertMediaReferences(tx, ownerId, write, touchedMedia(patch));
    const revision = row.draftRevision + 1;
    const savedAt = new Date();
    await tx.update(profiles).set({ draft: write, draftRevision: revision, draftUpdatedAt: savedAt }).where(eq(profiles.id, row.id));
    return { revision, savedAt, blocks: doc.blocks, theme: doc.theme, appearance: appearanceOf(theme) };
  });
}

/**
 * Atomically (optionally) applies a draft patch and publishes the resulting
 * draft. The row is locked and the caller's `expectedRevision` must match, so
 * a concurrent save can never cause a different draft to be published; any
 * failure (including an unreadable theme or a failed contrast check) rolls
 * back both the draft and the published snapshot. Every uploaded image the
 * published document references must be the owner's, of the right kind and,
 * in an image block, of the stored size.
 */
export async function publishProfile(ownerId: string, profileId: string, input: unknown) {
  const { expectedRevision, patch } = parseOrThrow(publishInput, input);
  if (patch) assertExternalAvatar(patch.header.avatarUrl);
  return db.transaction(async (tx) => {
    const row = await lockOwned(tx, ownerId, profileId);
    assertRevision(row.draftRevision, expectedRevision);
    const merged = patch
      ? mergePatch(row.draft, row.published, patch, await lockImageSizes(tx, ownerId, imageSources(patch)))
      : storedDocument(row.draft);
    assertPublishable(merged);
    await assertMediaReferences(tx, ownerId, merged.write);
    const { doc, write, theme } = merged;
    const revision = patch ? row.draftRevision + 1 : row.draftRevision;
    const now = new Date();
    await tx
      .update(profiles)
      .set({
        ...(patch ? { draft: write, draftUpdatedAt: now } : {}),
        draftRevision: revision,
        published: write,
        publishedRevision: revision,
        isPublished: true,
        publishedAt: now,
      })
      .where(eq(profiles.id, row.id));
    return { id: row.id, handle: row.handle, revision, publishedAt: now, blocks: doc.blocks, theme: doc.theme, appearance: appearanceOf(theme) };
  });
}

export async function unpublishProfile(ownerId: string, profileId: string) {
  if (!z.uuid().safeParse(profileId).success) throw new AppError("Profile not found", "NOT_FOUND");
  const [row] = await db
    .update(profiles)
    .set({ isPublished: false })
    .where(and(eq(profiles.id, profileId), eq(profiles.ownerId, ownerId)))
    .returning({ id: profiles.id, handle: profiles.handle });
  if (!row) throw new AppError("Profile not found", "NOT_FOUND");
  return row;
}

/** Discards draft edits, restoring the last published snapshot as a new revision. */
export async function revertDraft(ownerId: string, profileId: string, input: unknown) {
  const { expectedRevision } = parseOrThrow(revertInput, input);
  return db.transaction(async (tx) => {
    const row = await lockOwned(tx, ownerId, profileId);
    assertRevision(row.draftRevision, expectedRevision);
    if (!row.published) throw new AppError("This profile has never been published.", "VALIDATION");
    const revision = row.draftRevision + 1;
    await tx
      .update(profiles)
      .set({ draft: row.published, draftRevision: revision, publishedRevision: revision, draftUpdatedAt: new Date() })
      .where(eq(profiles.id, row.id));
    return { id: row.id, handle: row.handle, revision };
  });
}

export async function deleteProfile(ownerId: string, profileId: string) {
  if (!z.uuid().safeParse(profileId).success) throw new AppError("Profile not found", "NOT_FOUND");
  const [row] = await db
    .delete(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.ownerId, ownerId)))
    .returning({ id: profiles.id, handle: profiles.handle });
  if (!row) throw new AppError("Profile not found", "NOT_FOUND");
  return row;
}
