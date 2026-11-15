import { describe, expect, it } from "vitest";
import { editorStatus, type EditorStatusInput } from "@/components/editor/editor-status";

const base: EditorStatusInput = {
  pending: null,
  outcome: null,
  invalid: false,
  needsAttention: false,
  dirty: false,
  isPublished: false,
  hasUnpublishedChanges: false,
  locked: false,
  themeUnreadable: false,
};
const at = (over: Partial<EditorStatusInput>) => editorStatus({ ...base, ...over });

describe("editor save/publish states", () => {
  it("covers every resting state with words, not colour alone", () => {
    expect(at({}).label).toBe("Not published");
    expect(at({ isPublished: true }).label).toBe("Published · up to date");
    expect(at({ isPublished: true, hasUnpublishedChanges: true }).label).toBe("Unpublished changes");
    expect(at({ dirty: true }).label).toBe("Unsaved changes");
    expect(at({ locked: true, dirty: true }).key).toBe("locked");
    expect(at({ themeUnreadable: true }).key).toBe("publish-blocked");
  });

  it("names the operation in flight and disables both actions", () => {
    for (const [op, key] of [["save", "saving"], ["publish", "publishing"], ["discard", "working"]] as const) {
      const s = at({ pending: op, dirty: true });
      expect(s.key).toBe(key);
      expect(s.icon).toBe("spinner");
      expect([s.canSave, s.canPublish]).toEqual([false, false]);
    }
  });

  it("keeps a failure visible until the next operation, by operation", () => {
    const err = (op: "save" | "publish", reason: "invalid" | "network" | "other" | "conflict") =>
      at({ dirty: true, outcome: { kind: "error", op, reason, text: "x" } });
    expect(err("save", "network").key).toBe("save-failed");
    expect(err("save", "network").canSave).toBe(true); // retry
    expect(err("publish", "other").key).toBe("publish-failed");
    expect(err("publish", "invalid").key).toBe("invalid");
    expect(err("save", "invalid").key).toBe("save-failed"); // a refused save is not a blocked publish
  });

  it("stops saving and publishing on a revision conflict until reload", () => {
    const s = at({ dirty: true, isPublished: true, outcome: { kind: "error", op: "save", reason: "conflict", text: "x" } });
    expect(s.key).toBe("conflict");
    expect([s.canSave, s.canPublish]).toEqual([false, false]);
  });

  it("labels Publish by what it would do and blocks it when it can't", () => {
    expect(at({}).publishLabel).toBe("Publish");
    expect(at({ isPublished: true, dirty: true }).publishLabel).toBe("Publish changes");
    const upToDate = at({ isPublished: true });
    expect([upToDate.publishLabel, upToDate.canPublish]).toEqual(["Published", false]);
    expect(at({ themeUnreadable: true, dirty: true }).canPublish).toBe(false);
    expect(at({ themeUnreadable: true, dirty: true }).canSave).toBe(true); // content still saves when only the theme is unreadable
    expect(at({ locked: true, dirty: true }).canSave).toBe(false); // stored blocks it can't rewrite
    expect(at({ dirty: false }).canSave).toBe(false);
  });
});

for (const op of ["save", "publish", "unpublish", "discard", "replace"] as const) {
  it(`blocks publish, never save, after invalid ${op}`, () => {
    const state = at({ dirty: true, outcome: { kind: "error", op, reason: "invalid", text: "Invalid" } });
    expect([state.canSave, state.canPublish]).toEqual([true, false]);
  });
}
describe("invalid content keeps Publish blocked whatever runs next, and can still be saved", () => {
  // Unpublish replaces the outcome but leaves the content as it was.
  const published = { isPublished: true, dirty: true, invalid: true } as const;

  it("keeps Publish off after a successful Unpublish", () => {
    const s = at({ ...published, isPublished: false, outcome: { kind: "success", op: "unpublish", text: "Unpublished." } });
    expect(s.key).toBe("invalid");
    expect([s.canSave, s.canPublish]).toEqual([true, false]);
  });

  it("keeps Publish off after a failed Unpublish, naming the failure", () => {
    for (const reason of ["network", "other"] as const) {
      const s = at({ ...published, outcome: { kind: "error", op: "unpublish", reason, text: "Offline" } });
      expect(s.key).toBe("unpublish-failed");
      expect([s.canSave, s.canPublish]).toEqual([true, false]);
    }
  });

  it("keeps both off while Unpublish runs, and Publish off with no outcome at all", () => {
    expect([at({ ...published, pending: "unpublish" }).canSave, at({ ...published, pending: "unpublish" }).canPublish]).toEqual([false, false]);
    const s = at(published);
    expect([s.key, s.canSave, s.canPublish]).toEqual(["invalid", true, false]);
  });

  it("allows both once the content is no longer marked invalid", () => {
    const s = at({ ...published, invalid: false, outcome: { kind: "success", op: "unpublish", text: "Unpublished." } });
    expect([s.canSave, s.canPublish]).toEqual([true, true]);
  });
});

for (const op of ["unpublish", "discard", "replace"] as const) {
  it(`names a failed ${op}`, () => {
    expect(at({ outcome: { kind: "error", op, reason: "network", text: "Offline" } }).key).toBe(`${op}-failed`);
  });
}

describe("a saved draft that needs attention", () => {
  it("is saved, not dirty, and can't be published as it is", () => {
    const s = at({ needsAttention: true, hasUnpublishedChanges: true });
    expect([s.key, s.label, s.tone]).toEqual(["needs-attention", "Saved · needs attention", "warn"]);
    expect([s.canSave, s.canPublish]).toEqual([false, false]);
  });

  it("can be published together with the edits that fix it", () => {
    const s = at({ needsAttention: true, dirty: true });
    expect(s.key).toBe("unsaved");
    expect([s.canSave, s.canPublish]).toEqual([true, true]);
  });

  it("stays distinct from a failed save and from a publish blocked by validation", () => {
    const failed = at({ needsAttention: true, dirty: true, outcome: { kind: "error", op: "save", reason: "network", text: "Offline" } });
    const blocked = at({ needsAttention: true, dirty: true, outcome: { kind: "error", op: "publish", reason: "invalid", text: "Invalid" } });
    expect([failed.key, blocked.key]).toEqual(["save-failed", "invalid"]);
    expect([failed.canSave, blocked.canSave, blocked.canPublish]).toEqual([true, true, false]);
  });

  it("keeps a published page's draft from being published while it needs attention", () => {
    expect(at({ needsAttention: true, isPublished: true, hasUnpublishedChanges: true }).canPublish).toBe(false);
  });
});
