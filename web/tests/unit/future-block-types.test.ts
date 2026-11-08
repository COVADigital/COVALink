import { describe, expect, it, vi } from "vitest";

/**
 * The future-type invariant. Every shipped type is editable,
 * so this fixture narrows the editable list to make a registered type, `music`,
 * noneditable: the state a staged future type would be in. Without the
 * invariant, a list that leaves such a block out would delete it silently.
 */
vi.mock("@/features/blocks/definitions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/blocks/definitions")>();
  return {
    ...real,
    EDITABLE_BLOCK_TYPES: real.EDITABLE_BLOCK_TYPES.filter((t) => t !== "music"),
    isEditableBlockType: (value: string) => value !== "music" && real.isEditableBlockType(value),
  };
});

import { toBlockInput, toEditorItems, toViewBlocks } from "@/components/editor/block-items";
import type { Block } from "@/features/blocks/block";
import { assessStoredBlocks, resolveBlockList } from "@/features/blocks/input";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LINK = { id: ID(1), type: "link", version: 2, visible: true, config: { title: "A", url: "https://a.example.com/" } };
const MUSIC = { id: ID(2), type: "music", version: 2, visible: true, config: { url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" } };

describe("a registered, noneditable block", () => {
  it("counts as protected and isn't in the draft map", () => {
    const stored = assessStoredBlocks([LINK, MUSIC], []);
    expect(stored).toMatchObject({ unreadable: 0, lossy: 0, nonEditable: 1, overflow: 0, protectedCount: 1 });
    expect([...stored.draft.keys()]).toEqual([ID(1)]);
    expect(stored.knownTypes.get(ID(2))).toBe("music");
  });

  it("counts every such block, alongside the other protections", () => {
    const stored = assessStoredBlocks([MUSIC, { ...MUSIC, id: ID(3) }, { id: ID(4), type: "future-widget", version: 1, visible: true, config: {} }], []);
    expect(stored).toMatchObject({ unreadable: 1, nonEditable: 2, protectedCount: 3 });
  });

  it("is withheld from editable state and from the preview", () => {
    const items = toEditorItems([LINK, MUSIC] as unknown as Block[]);
    expect(items.map((i) => i.id)).toEqual([ID(1)]);
    expect(toBlockInput(items).map((b) => b.id)).toEqual([ID(1)]);
    expect(toViewBlocks(items).map((b) => b.id)).toEqual([ID(1)]);
  });

  it("can't be created or edited through a client list", () => {
    const stored = assessStoredBlocks([], []);
    const r = resolveBlockList([{ id: ID(2), type: "music", visible: true, config: { url: MUSIC.config.url } }], stored);
    expect(r).toMatchObject({ ok: false, errors: { items: [{ index: 0, id: ID(2), message: "This kind of block can't be created or edited yet." }] } });
  });

  it("gives the caller what it needs to refuse before reading a list that omits it or holds a stale preserve entry", () => {
    // `refuseProtected` throws on `protectedCount > 0` before `resolveBlockList` runs; the
    // integration suite proves the write is refused. Here: the count holds for both client lists.
    expect(assessStoredBlocks([LINK, MUSIC], []).protectedCount).toBeGreaterThan(0);
    const unprotected = assessStoredBlocks([LINK], []);
    expect(resolveBlockList([{ id: ID(2), preserve: true }], unprotected)).toMatchObject({ ok: false, errors: { items: [{ message: "This block is malformed." }] } });
  });
});

describe("registry", () => {
  it("lists only registered types as editable and renderable", async () => {
    const real = await vi.importActual<typeof import("@/features/blocks/definitions")>("@/features/blocks/definitions");
    for (const type of [...real.EDITABLE_BLOCK_TYPES, ...real.RENDERABLE_BLOCK_TYPES]) {
      expect(Object.hasOwn(real.BLOCK_DEFINITIONS, type), type).toBe(true);
    }
    expect(Object.keys(real.BLOCK_INPUT_SCHEMAS).sort()).toEqual([...real.EDITABLE_BLOCK_TYPES].sort());
  });
});
