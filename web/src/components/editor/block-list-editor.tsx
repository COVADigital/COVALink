"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ChevronDown,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  GripVertical,
  MoreHorizontal,
  Plus,
  Trash,
} from "lucide-react";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import type { Block } from "@/features/blocks/block";
import { BLOCK_DEFINITIONS, EDITABLE_BLOCK_TYPES, MAX_SOCIAL_ITEMS, type EditableBlockType } from "@/features/blocks/definitions";
import { MAX_BLOCKS } from "@/features/blocks/input";
import type { BlockListErrors } from "@/lib/errors";
import { AudienceContext, BLOCK_EDITORS, blockFieldId, FIRST_FIELD, rowControlId, TOUCH_ICON, TOUCH_TARGET, type BlockEditorProps } from "./block-editors";
import {
  createItem,
  duplicateItem,
  imageSources,
  itemLabel,
  moveItem,
  newSocialRow,
  rowLabel,
  serializeItems,
  toBlockInput,
  toEditorItems,
  toViewBlocks,
  validateItem,
  type EditableItem,
  type ImageSizes,
  type ItemValidation,
  type LoadedBlock,
  type SocialRow,
} from "./block-items";

type Media = BlockEditorProps["media"];

/*
 * Block list editor. Move up / Move down are the canonical, always
 * available reorder controls; dnd-kit drag (pointer and keyboard) is a
 * progressive enhancement on top. Every focus target has a stable DOM id
 * (`blk-{id}-…`), so focus can be restored after a re-render.
 */

const ctrlId = (blockId: string, control: "toggle" | "up" | "down" | "panel") => `blk-${blockId}-${control}`;
const addId = (type: EditableBlockType) => `add-block-${type}`;

type ItemErrors = { message?: string; fields?: Record<string, string[]> };

/** Server block errors by the items that were sent (by id, else by position). */
function serverErrors(errors: BlockListErrors, sent: readonly EditableItem[]) {
  const byId: Record<string, ItemErrors> = {};
  const list = [...errors.list];
  for (const e of errors.items) {
    const id = e.id ?? sent[e.index]?.id;
    if (id) byId[id] = { message: e.message, fields: e.fields };
    else if (e.message) list.push(e.message);
  }
  return { list, byId };
}

/**
 * State and operations for the block list; owned by the profile editor.
 * `kept` reopens an unfinished draft: its blocks as they were sent, with the
 * problems reported when it was saved.
 */
export function useBlockList(initial: readonly Block[], kept?: { blocks?: readonly LoadedBlock[]; errors?: BlockListErrors; sizes?: ImageSizes }) {
  const [items, setItems] = useState<EditableItem[]>(() => toEditorItems(kept?.blocks ?? initial, kept?.sizes));
  // The items as last saved: what "unsaved changes" compares with and what leaving without saving restores.
  const [savedItems, setSavedItems] = useState(items);
  const saved = useMemo(() => serializeItems(savedItems), [savedItems]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [submitted, setSubmitted] = useState(kept !== undefined);
  const [server, setServer] = useState<{ list: string[]; byId: Record<string, ItemErrors> }>(() =>
    kept?.errors ? serverErrors(kept.errors, items) : { list: [], byId: {} },
  );
  const [announcement, setAnnouncement] = useState("");
  // The block being worked on; the editor marks it in the preview.
  const [selected, setSelected] = useState<string | null>(null);
  const pendingFocus = useRef<string[] | null>(null);

  // Runs after every commit: move focus once the element it targets exists.
  useEffect(() => {
    const ids = pendingFocus.current;
    if (!ids) return;
    pendingFocus.current = null;
    for (const id of ids) {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (!el || el.disabled) continue;
      // Disabled only by the editor's fieldset while a request is in flight: focus it once that ends.
      if (el.matches(":disabled")) pendingFocus.current = ids;
      else el.focus();
      return;
    }
  });

  const validations = useMemo(() => {
    const m = new Map<string, ItemValidation>();
    for (const i of items) m.set(i.id, validateItem(i));
    return m;
  }, [items]);
  const viewBlocks = useMemo(() => toViewBlocks(items), [items]);
  const dirty = useMemo(() => serializeItems(items) !== saved, [items, saved]);
  const images = useMemo(() => imageSources(items), [items]);

  const focus = (...ids: string[]) => {
    pendingFocus.current = ids;
  };
  const expand = (ids: string[]) => setExpanded((s) => new Set([...s, ...ids]));
  const clearServer = (id: string) =>
    setServer((s) => {
      if (!s.byId[id]) return s;
      const byId = { ...s.byId };
      delete byId[id];
      return { ...s, byId };
    });

  function load(blocks: readonly Block[]) {
    const next = toEditorItems(blocks);
    setItems(next);
    setSavedItems(next);
    setSubmitted(false);
    setTouched(new Set());
    setServer({ list: [], byId: {} });
  }

  return {
    items,
    expanded,
    viewBlocks,
    dirty,
    announcement,
    selected,
    select: (id: string) => setSelected(id),
    /** Uploaded images chosen in image blocks, saved or not. */
    images,
    listErrors: server.list,
    toInput: () => toBlockInput(items),
    /** After a successful save/publish/discard: adopt the server's canonical blocks. */
    load,
    /** After an unfinished draft was saved: the items sent are the saved ones, exactly as typed. */
    markSaved: (sent: EditableItem[]) => setSavedItems(sent),
    /** Drops unsaved edits, going back to the items as last saved. */
    revert: () => setItems(savedItems),

    errorsFor(item: EditableItem): { message?: string; fields: Record<string, string | undefined>; attention: boolean } {
      const s = server.byId[item.id];
      const v = validations.get(item.id);
      const fields: Record<string, string | undefined> = {};
      const clientFields = v && !v.ok ? v.fields : {};
      for (const f of new Set([...Object.keys(clientFields), ...Object.keys(s?.fields ?? {})])) {
        fields[f] = s?.fields?.[f]?.[0] ?? (submitted || touched.has(`${item.id}:${f}`) ? clientFields[f]?.[0] : undefined);
      }
      const clientInvalid = !!v && !v.ok;
      return { message: s?.message ?? (submitted && v && !v.ok ? v.message : undefined), fields, attention: !!s || (submitted && clientInvalid) };
    },

    /** Before saving: if any block is invalid, reveal the problems and focus the first one. */
    revealProblems(): boolean {
      const bad = items.filter((i) => validations.get(i.id)?.ok === false);
      if (bad.length === 0) return false;
      setSubmitted(true);
      expand(bad.map((i) => i.id));
      const first = bad[0];
      const v = validations.get(first.id);
      const field = v && !v.ok ? Object.keys(v.fields)[0] : undefined;
      focus(...(field ? [blockFieldId(first.id, field)] : []), ctrlId(first.id, "toggle"));
      return true;
    },

    /** Maps server block errors onto the items that were sent (by id, else by position). */
    applyServerErrors(errors: BlockListErrors, sent: readonly EditableItem[]) {
      const next = serverErrors(errors, sent);
      setServer(next);
      setSubmitted(true);
      const ids = Object.keys(next.byId);
      expand(ids);
      if (ids[0]) focus(ctrlId(ids[0], "toggle"));
    },

    add(type: EditableBlockType) {
      const item = createItem(type);
      setItems((xs) => [...xs, item]);
      expand([item.id]);
      setSelected(item.id);
      setAnnouncement(`Added a ${BLOCK_DEFINITIONS[type].label.toLowerCase()} block at the end.`);
      focus(blockFieldId(item.id, FIRST_FIELD[type]));
    },

    update(id: string, field: string, value: string) {
      setItems((xs) => xs.map((i) => (i.id === id ? { ...i, values: { ...i.values, [field]: value } } : i)));
      clearServer(id);
    },

    /** Social rows: Move up / Move down keep focus on the control used and announce the move, like blocks. */
    rows(id: string) {
      const item = items.find((i) => i.id === id);
      const rows = item?.rows ?? [];
      const updateRows = (fn: (current: SocialRow[]) => SocialRow[]) => {
        setItems((xs) => xs.map((i) => (i.id === id ? { ...i, rows: fn(i.rows ?? []) } : i)));
        clearServer(id);
      };
      return {
        add() {
          if (rows.length >= MAX_SOCIAL_ITEMS) return;
          updateRows((current) => [...current, newSocialRow()]);
          setAnnouncement(`Added social link ${rows.length + 1} of ${rows.length + 1}.`);
          focus(blockFieldId(id, `items.${rows.length}.platform`));
        },
        remove(index: number) {
          const row = rows[index];
          if (!row) return;
          updateRows((current) => current.filter((r) => r.key !== row.key));
          setAnnouncement(`Removed social link ${index + 1} (${rowLabel(row)}). Save to keep this change.`);
          const target = index < rows.length - 1 ? index : index - 1;
          focus(...(target >= 0 ? [rowControlId(id, target, "remove")] : []), blockFieldId(id, "items"));
        },
        move(from: number, to: number, via: "up" | "down") {
          if (to < 0 || to >= rows.length || from === to) return;
          updateRows((current) => moveItem(current, from, to));
          setAnnouncement(`Moved social link ${rowLabel(rows[from])} to position ${to + 1} of ${rows.length}.`);
          focus(rowControlId(id, to, via), rowControlId(id, to, via === "up" ? "down" : "up"));
        },
        change(index: number, field: "platform" | "url", value: string) {
          updateRows((current) => current.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
        },
      };
    },

    touch(id: string, field: string) {
      setTouched((s) => (s.has(`${id}:${field}`) ? s : new Set([...s, `${id}:${field}`])));
    },

    setVisible(id: string, visible: boolean) {
      setItems((xs) => xs.map((i) => (i.id === id ? { ...i, visible } : i)));
      clearServer(id);
    },

    toggleExpanded(id: string) {
      setExpanded((s) => {
        const next = new Set(s);
        if (!next.delete(id)) next.add(id);
        return next;
      });
      setSelected(id);
    },

    /** Moves a block and announces it; focus stays on the control used, or the other one at an edge. */
    /** "menu": focus returns to the row's ⋯ trigger, which moves with the block. */
    move(from: number, to: number, via: "up" | "down" | "drag" | "menu") {
      if (to < 0 || to >= items.length || from === to) return;
      const item = items[from];
      setItems(moveItem(items, from, to));
      setAnnouncement(`Moved “${itemLabel(item)}” to position ${to + 1} of ${items.length}.`);
      if (via === "up") focus(ctrlId(item.id, "up"), ctrlId(item.id, "down"));
      if (via === "down") focus(ctrlId(item.id, "down"), ctrlId(item.id, "up"));
    },

    duplicate(index: number) {
      const item = items[index];
      if (!item || items.length >= MAX_BLOCKS) return;
      const copy = duplicateItem(item);
      setItems([...items.slice(0, index + 1), copy, ...items.slice(index + 1)]);
      setAnnouncement(`Duplicated “${itemLabel(item)}”. The copy is at position ${index + 2}.`);
      focus(ctrlId(copy.id, "toggle"));
    },

    remove(index: number) {
      const item = items[index];
      if (!item) return;
      const next = items[index + 1] ?? items[index - 1];
      setItems(items.filter((_, i) => i !== index));
      clearServer(item.id);
      setAnnouncement(`Deleted “${itemLabel(item)}”. Save to keep this change.`);
      focus(...(next ? [ctrlId(next.id, "toggle")] : []), addId("link"));
    },
  };
}

export type BlockListState = ReturnType<typeof useBlockList>;

function SortableBlock({
  item,
  index,
  count,
  list,
  disabled,
  media,
}: {
  item: EditableItem;
  index: number;
  count: number;
  list: BlockListState;
  disabled: boolean;
  media: Media;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  const label = itemLabel(item);
  const typeLabel = BLOCK_DEFINITIONS[item.type].label;
  const isOpen = list.expanded.has(item.id);
  const errors = list.errorsFor(item);
  const headingId = `blk-${item.id}-heading`;
  const selected = list.selected === item.id;
  const visibleId = blockFieldId(item.id, "visible");

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // Focus anywhere in the row selects it, so keyboard users get the linked preview mark too.
      onFocus={() => list.select(item.id)}
      className={[
        "rounded-cl-md",
        item.visible ? "bg-cl-surface" : "border-dashed bg-cl-canvas",
        // Selection is never colour alone: the open panel and the "Editing" label go with it.
        errors.attention ? "-m-px border-2 border-cl-danger" : selected ? "-m-px border-2 border-cl-accent" : item.visible ? "border border-cl-line" : "border border-cl-line-strong",
        "data-[dragging=true]:z-10 data-[dragging=true]:border-dashed data-[dragging=true]:border-cl-ink data-[dragging=true]:shadow-lg",
      ].join(" ")}
      data-dragging={isDragging || undefined}
      data-selected={selected || undefined}
      data-testid="block-card"
      data-block-id={item.id}
      data-block-type={item.type}
      aria-labelledby={headingId}
      aria-current={selected ? "true" : undefined}
      aria-details={selected && item.visible ? `profile-block-${item.id}` : undefined}
      aria-describedby={selected ? `blk-${item.id}-selection` : undefined}
    >
      {selected && <span id={`blk-${item.id}-selection`} className="sr-only" role="status">Selected block: {label}. {item.visible ? "Matching block highlighted in the draft preview." : "Hidden from the draft preview."}</span>}
      <div className="flex items-center gap-1 p-1">
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="inline-flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-cl-sm text-cl-ink-2 outline-none max-ed-lg:size-11 hover:bg-cl-inset hover:text-cl-ink focus-visible:ring-2 focus-visible:ring-cl-accent disabled:cursor-not-allowed disabled:opacity-50 data-[dragging=true]:bg-cl-ink data-[dragging=true]:text-cl-surface"
          data-dragging={isDragging || undefined}
          aria-label={`Drag to reorder “${label}”`}
          disabled={disabled}
          data-testid="block-drag-handle"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>

        <button
          id={ctrlId(item.id, "toggle")}
          type="button"
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-cl-sm px-1.5 py-1 text-left outline-none max-ed-lg:min-h-11 hover:bg-cl-inset focus-visible:ring-2 focus-visible:ring-cl-accent"
          aria-expanded={isOpen}
          aria-controls={ctrlId(item.id, "panel")}
          onClick={() => list.toggleExpanded(item.id)}
        >
          <ChevronDown className={`size-4 shrink-0 text-cl-ink-2 motion-safe:transition-transform ${isOpen ? "" : "-rotate-90"}`} aria-hidden="true" />
          <span id={headingId} className="grid min-w-0">
            <span className="text-xs text-cl-ink-2">
              <span className="sr-only">Edit </span>
              {typeLabel}
            </span>
            <span className="truncate text-sm font-semibold" data-testid="block-label">
              {label}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {errors.attention ? (
            // Phone: the icon alone (shortened); the red border and the field errors carry the detail.
            <span className="inline-flex items-center gap-1 rounded-cl-sm border border-cl-danger px-1.5 py-0.5 text-xs font-semibold text-cl-danger">
              <CircleAlert className="size-3.5" aria-hidden="true" />
              <span className="max-ed-md:sr-only">Needs attention</span>
            </span>
          ) : (
            selected &&
            isOpen && (
              <span className="rounded-cl-sm border border-cl-line-strong px-1.5 py-0.5 text-xs font-semibold text-cl-ink-2 max-ed-md:hidden">Editing</span>
            )
          )}
          <label
            htmlFor={visibleId}
            className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-cl-sm px-1.5 text-xs font-semibold text-cl-ink-2 max-ed-lg:min-h-11 hover:bg-cl-inset"
          >
            <Switch
              id={visibleId}
              checked={item.visible}
              disabled={disabled}
              aria-label={`Show “${label}” on page`}
              onCheckedChange={(v) => list.setVisible(item.id, v)}
            />
            <span aria-hidden="true" data-testid={item.visible ? undefined : "block-hidden-badge"}>
              {item.visible ? "Shown" : "Hidden"}
            </span>
          </label>
          <Button
            id={ctrlId(item.id, "up")}
            type="button"
            variant="ghost"
            size="icon"
            className={`${TOUCH_ICON} max-ed-md:hidden`}
            aria-label={`Move “${label}” up`}
            disabled={disabled || index === 0}
            onClick={() => list.move(index, index - 1, "up")}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            id={ctrlId(item.id, "down")}
            type="button"
            variant="ghost"
            size="icon"
            className={`${TOUCH_ICON} max-ed-md:hidden`}
            aria-label={`Move “${label}” down`}
            disabled={disabled || index === count - 1}
            onClick={() => list.move(index, index + 1, "down")}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          <BlockMenu item={item} index={index} count={count} list={list} disabled={disabled} />
        </div>
      </div>

      {isOpen && (
        <BlockPanel item={item} index={index} list={list} disabled={disabled} message={errors.message} fields={errors.fields} media={media} />
      )}
    </li>
  );
}

/**
 * Row actions. Move up / Move down are also visible buttons from 45rem;
 * on phones this menu is where they live. Focus returns to the trigger, which
 * moves with its block, and every move is announced.
 */
function BlockMenu({ item, index, count, list, disabled }: { item: EditableItem; index: number; count: number; list: BlockListState; disabled: boolean }) {
  const label = itemLabel(item);
  const row = "min-h-11 ed-lg:min-h-9";
  // Duplicate and Delete move focus themselves (to the copy, or the next block); the menu mustn't take it back.
  const ownFocus = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-10 max-ed-lg:size-11" aria-label={`More actions for “${label}”`} disabled={disabled}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-52"
        onCloseAutoFocus={(e) => {
          if (ownFocus.current) e.preventDefault();
          ownFocus.current = false;
        }}
      >
        <DropdownMenuItem className={row} disabled={index === 0} onSelect={() => list.move(index, index - 1, "menu")}>
          <ArrowUp aria-hidden="true" />
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem className={row} disabled={index === count - 1} onSelect={() => list.move(index, index + 1, "menu")}>
          <ArrowDown aria-hidden="true" />
          Move down
        </DropdownMenuItem>
        <DropdownMenuItem className={row} disabled={index === 0} onSelect={() => list.move(index, 0, "menu")}>
          <ArrowUpToLine aria-hidden="true" />
          Move to top
        </DropdownMenuItem>
        <DropdownMenuItem className={row} disabled={index === count - 1} onSelect={() => list.move(index, count - 1, "menu")}>
          <ArrowDownToLine aria-hidden="true" />
          Move to bottom
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className={row}
          disabled={list.items.length >= MAX_BLOCKS}
          onSelect={() => {
            ownFocus.current = true;
            list.duplicate(index);
          }}
        >
          <Copy aria-hidden="true" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem className={row} onSelect={() => list.setVisible(item.id, !item.visible)}>
          {item.visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          {item.visible ? "Hide from page" : "Show on page"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className={row}
          variant="destructive"
          onSelect={() => {
            ownFocus.current = true;
            list.remove(index);
          }}
        >
          <Trash aria-hidden="true" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BlockPanel({
  item,
  index,
  list,
  disabled,
  message,
  fields,
  media,
}: {
  item: EditableItem;
  index: number;
  list: BlockListState;
  disabled: boolean;
  message?: string;
  fields: Record<string, string | undefined>;
  media: Media;
}) {
  const Editor = BLOCK_EDITORS[item.type];
  const label = itemLabel(item);
  return (
    <div id={ctrlId(item.id, "panel")} className="grid gap-4 border-t border-cl-line p-4 ed-md:pl-12">
      {message && (
        <p className="text-sm text-destructive" data-testid="block-error">
          {message}
        </p>
      )}
      <fieldset disabled={disabled} className="grid gap-4">
        <legend className="sr-only">{BLOCK_DEFINITIONS[item.type].label} settings</legend>
        <Editor
          item={item}
          errors={fields}
          onChange={(field, value) => list.update(item.id, field, value)}
          onBlur={(field) => list.touch(item.id, field)}
          socialRows={list.rows(item.id)}
          media={media}
        />
      </fieldset>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={TOUCH_TARGET}
            disabled={disabled || list.items.length >= MAX_BLOCKS}
            onClick={() => list.duplicate(index)}
            aria-label={`Duplicate “${label}”`}
          >
            <Copy aria-hidden="true" />
            Duplicate
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={TOUCH_TARGET}
            disabled={disabled}
            onClick={() => list.remove(index)}
            aria-label={`Delete “${label}”`}
          >
            <Trash aria-hidden="true" />
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

export function BlockListEditor({ list, disabled, media }: { list: BlockListState; disabled: boolean; media: Media }) {
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const { items } = list;
  const indexOf = (id: string | number) => items.findIndex((i) => i.id === String(id));
  const labelOf = (id: string | number) => {
    const i = items[indexOf(id)];
    return i ? `“${itemLabel(i)}”` : "block";
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${labelOf(active.id)}, position ${indexOf(active.id) + 1} of ${items.length}.`,
    onDragOver: ({ active, over }) =>
      over ? `${labelOf(active.id)} is over position ${indexOf(over.id) + 1} of ${items.length}.` : `${labelOf(active.id)} is not over a position.`,
    onDragEnd: ({ active, over }) =>
      over ? `Dropped ${labelOf(active.id)} at position ${indexOf(over.id) + 1} of ${items.length}.` : `Dropped ${labelOf(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled. ${labelOf(active.id)} stays at position ${indexOf(active.id) + 1}.`,
  };

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    list.move(indexOf(active.id), indexOf(over.id), "drag");
  }

  const full = items.length >= MAX_BLOCKS;
  const { subscribeEnabled } = useContext(AudienceContext);
  const addableTypes = EDITABLE_BLOCK_TYPES.filter((t) => t !== "subscribe" || subscribeEnabled);

  return (
    <section aria-labelledby="blocks-heading" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="blocks-heading" className="text-sm font-medium">
          Blocks
        </h3>
        <p className="text-xs text-muted-foreground">
          {items.length} of {MAX_BLOCKS}
        </p>
      </div>

      {list.listErrors.length > 0 && (
        <ul className="grid gap-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="block-list-errors">
          {list.listErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground" data-testid="blocks-empty">
          No blocks yet. Add one below.
        </p>
      ) : (
        <DndContext
          id={dndId}
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable:
                "To reorder with the keyboard, press Space to pick up this block, use the arrow keys to move it, then press Space to drop it or Escape to cancel. The Move up and Move down buttons do the same.",
            },
          }}
        >
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ol className="grid gap-2" aria-label="Blocks, in page order" data-testid="block-list">
              {items.map((item, index) => (
                <SortableBlock key={item.id} item={item} index={index} count={items.length} list={list} disabled={disabled} media={media} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      <div className="grid gap-2">
        <p className="text-xs font-medium text-muted-foreground" id="add-block-label">
          Add block
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="add-block-label">
          {addableTypes.map((type) => (
            <Button
              key={type}
              id={addId(type)}
              type="button"
              variant="outline"
              size="sm"
              className={TOUCH_TARGET}
              disabled={disabled || full}
              onClick={() => list.add(type)}
            >
              <Plus aria-hidden="true" />
              {BLOCK_DEFINITIONS[type].label}
            </Button>
          ))}
        </div>
        {full && <p className="text-xs text-muted-foreground">You&apos;ve reached the limit of {MAX_BLOCKS} blocks.</p>}
      </div>

      <p role="status" aria-live="polite" className="sr-only" data-testid="blocks-announcer">
        {list.announcement}
      </p>
    </section>
  );
}
