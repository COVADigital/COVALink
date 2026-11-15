/**
 * The profile editor's save/publish state model. Pure, so every state
 * the top bar can show is unit-tested. It describes the real editor: an
 * explicit "Save draft" (no autosave), a revision check on save and publish,
 * and discard-to-published.
 */

export type EditorOp = "save" | "publish" | "unpublish" | "discard" | "replace";

/** The outcome of the last operation, cleared when the next one starts. */
export type EditorOutcome =
  | { kind: "success"; op: EditorOp; text: string }
  | { kind: "error"; op: EditorOp; text: string; reason: "conflict" | "invalid" | "network" | "other" }
  | null;

export interface EditorStatusInput {
  /** The operation in flight, if any. */
  pending: EditorOp | null;
  outcome: EditorOutcome;
  /**
   * The content failed validation. Separate from the outcome: it stays until
   * the content changes or is reset, whatever other operation runs meanwhile.
   */
  invalid: boolean;
  /** Local edits not yet saved. */
  dirty: boolean;
  isPublished: boolean;
  /** The saved draft differs from the published version. */
  hasUnpublishedChanges: boolean;
  /** Stored blocks this version can't rewrite: saving and publishing are off. */
  locked: boolean;
  /** The saved theme can't be read: publishing is off. */
  themeUnreadable: boolean;
}

export type StatusTone = "neutral" | "ok" | "warn" | "bad";
export type StatusIcon = "spinner" | "check" | "dot" | "alert" | "lock";

export interface EditorStatus {
  key:
    | "saving"
    | "publishing"
    | "working"
    | "conflict"
    | "invalid"
    | "save-failed"
    | "publish-failed"
    | "unpublish-failed"
    | "discard-failed"
    | "replace-failed"
    | "locked"
    | "unsaved"
    | "publish-blocked"
    | "unpublished-changes"
    | "published"
    | "not-published";
  tone: StatusTone;
  icon: StatusIcon;
  /** Short words for the top bar; never colour alone. */
  label: string;
  canSave: boolean;
  canPublish: boolean;
  publishLabel: "Publish" | "Publish changes" | "Published";
}

const PENDING: Record<EditorOp, Pick<EditorStatus, "key" | "label">> = {
  save: { key: "saving", label: "Saving draft…" },
  publish: { key: "publishing", label: "Publishing…" },
  unpublish: { key: "working", label: "Unpublishing…" },
  discard: { key: "working", label: "Discarding changes…" },
  replace: { key: "working", label: "Replacing appearance…" },
};

export function editorStatus(s: EditorStatusInput): EditorStatus {
  const upToDate = s.isPublished && !s.hasUnpublishedChanges && !s.dirty;
  const conflict = s.outcome?.kind === "error" && s.outcome.reason === "conflict";
  const publishLabel = upToDate ? "Published" : s.isPublished ? "Publish changes" : "Publish";
  const invalid = s.invalid || (s.outcome?.kind === "error" && s.outcome.reason === "invalid");
  const canSave = !s.pending && !s.locked && !conflict && !invalid && s.dirty;
  const canPublish = !s.pending && !s.locked && !conflict && !invalid && !upToDate && !s.themeUnreadable;
  const base = { canSave, canPublish, publishLabel } as const;

  if (s.pending) return { ...base, ...PENDING[s.pending], tone: "neutral", icon: "spinner" };

  if (s.outcome?.kind === "error") {
    const { reason, op } = s.outcome;
    if (reason === "conflict") return { ...base, key: "conflict", tone: "bad", icon: "alert", label: "Out of date" };
    if (reason === "invalid") return { ...base, key: "invalid", tone: "bad", icon: "alert", label: "Needs attention" };
    if (op === "publish") return { ...base, key: "publish-failed", tone: "bad", icon: "alert", label: "Not published" };
    if (op === "unpublish") return { ...base, key: "unpublish-failed", tone: "bad", icon: "alert", label: "Unpublish failed" };
    if (op === "discard") return { ...base, key: "discard-failed", tone: "bad", icon: "alert", label: "Discard failed" };
    if (op === "replace") return { ...base, key: "replace-failed", tone: "bad", icon: "alert", label: "Replacement failed" };
    if (op === "save") return { ...base, key: "save-failed", tone: "bad", icon: "alert", label: "Not saved" };
  }

  if (invalid) return { ...base, key: "invalid", tone: "bad", icon: "alert", label: "Needs attention" };

  if (s.locked) return { ...base, key: "locked", tone: "warn", icon: "lock", label: "Saving turned off" };
  if (s.dirty) return { ...base, key: "unsaved", tone: "warn", icon: "dot", label: "Unsaved changes" };
  if (s.themeUnreadable) return { ...base, key: "publish-blocked", tone: "warn", icon: "lock", label: "Publishing turned off" };
  if (s.isPublished && s.hasUnpublishedChanges) {
    return { ...base, key: "unpublished-changes", tone: "neutral", icon: "dot", label: "Unpublished changes" };
  }
  if (s.isPublished) return { ...base, key: "published", tone: "ok", icon: "check", label: "Published · up to date" };
  return { ...base, key: "not-published", tone: "neutral", icon: "dot", label: "Not published" };
}

/** A rejected Server Action call (offline, server unreachable) rather than a returned error. */
export const NETWORK_ERROR: Record<EditorOp, string> = {
  save: "Couldn't reach COVALink, so your draft wasn't saved. Your edits are still here. Check your connection and try again.",
  publish: "Couldn't reach COVALink, so nothing was published. Your edits are still here and visitors still see the previous version.",
  unpublish: "Couldn't confirm whether Unpublish completed. Check your connection and the public page, then retry if needed.",
  discard: "Couldn't confirm whether Discard completed. Your local edits are still here. Check your connection and reload the latest version before retrying.",
  replace: "Couldn't confirm whether appearance replacement completed. Check your connection and reload the latest version before retrying in Design.",
};
