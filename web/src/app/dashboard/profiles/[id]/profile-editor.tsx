"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ChartLine, ChevronLeft, CircleAlert, CircleCheck, Dot, Eye, LoaderCircle, Lock, MoreHorizontal, Pencil, RotateCw, SquareArrowOutUpRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useEffect, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { useForm, useWatch, type FieldErrors } from "react-hook-form";
import { z } from "zod";
import { FormField } from "@/components/auth/form-field";
import { AppearanceEditor, useAppearance, type AppearanceInfo } from "@/components/editor/appearance-editor";
import { AudienceContext } from "@/components/editor/block-editors";
import { BlockListEditor, useBlockList } from "@/components/editor/block-list-editor";
import { editorStatus, NETWORK_ERROR, type EditorOp, type EditorOutcome, type EditorStatus } from "@/components/editor/editor-status";
import { MediaPicker, useMediaLibrary } from "@/components/editor/media-picker";
import { WorkspaceMenu, type WorkspaceLink } from "@/components/editor/workspace-nav";
import type { ViewBlock } from "@/components/profile/blocks";
import { ProfileView, type ViewDocument } from "@/components/profile/profile-view";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { BlockInput } from "@/features/blocks/input";
import { publishAction, revertDraftAction, saveDraftAction, unpublishAction } from "@/features/profiles/actions";
import type { ProfileDocument } from "@/features/profiles/document";
import type { MediaLibrary } from "@/features/media/types";
import type { DraftPatchInput, IncompleteDraft } from "@/features/profiles/draft-input";
import type { PresetId, ThemeConfig, ThemeInput } from "@/features/themes/schema";
import type { BlockListErrors } from "@/lib/errors";
import { guardedLink, navigateWithGuard, registerLeaveGuard, type ConfirmLeave } from "@/lib/navigation-guard";
import { isMediaUrl, parseImageSrc } from "@/lib/validation/media";

export const MetadataGuard = createContext<{ changed: (dirty: boolean) => void; registerReset: (reset: () => void) => () => void } | null>(null);

export interface EditorProfile {
  id: string;
  handle: string;
  verified: boolean;
  isPublished: boolean;
  everPublished: boolean;
  hasUnpublishedChanges: boolean;
  revision: number;
  draft: ProfileDocument;
  /** Stored draft blocks this version can't rewrite losslessly; saving is refused while > 0. */
  protectedBlocks: number;
  /** The unfinished draft saved last, opened in place of `draft`; it can't be published until it validates. */
  incomplete: IncompleteDraft | null;
  /** Whether the stored draft theme can be edited, is locked or is unreadable. */
  appearance: AppearanceInfo;
  /** The owner's uploaded images, or null if they couldn't be loaded. */
  media: MediaLibrary | null;
}

// Mirrors the server contract (features/profiles/draft-input.ts) for inline errors.
const formSchema = z.object({
  displayName: z.string().trim().min(1, "Add a display name").max(60, "Use at most 60 characters"),
  bio: z.string().max(300, "Use at most 300 characters"),
  avatarUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => !v || parseImageSrc(v) !== null, "Use an https:// image address"),
  seoTitle: z.string().trim().max(70, "Use at most 70 characters"),
  seoDescription: z.string().trim().max(160, "Use at most 160 characters"),
  noindex: z.boolean(),
});
type Values = z.infer<typeof formSchema>;

/** Form values of a stored draft, or of an unfinished one exactly as it was typed. */
function toValues({ header, seo }: Pick<IncompleteDraft, "header" | "seo">): Values {
  return {
    displayName: header.displayName,
    bio: header.bio,
    avatarUrl: header.avatarUrl ?? "",
    seoTitle: seo.title ?? "",
    seoDescription: seo.description ?? "",
    noindex: seo.noindex,
  };
}

const headerOf = (doc: ProfileDocument) => ({ header: doc.header, seo: doc.settings.seo });

/**
 * `theme` is sent only when the appearance changed: an omitted theme keeps
 * the stored one exactly, so a content save never rewrites it.
 */
function toPatch(v: Values, extra: { blocks?: BlockInput[]; theme?: ThemeInput; replaceTheme?: PresetId }): DraftPatchInput {
  return {
    header: { displayName: v.displayName, bio: v.bio, avatarUrl: v.avatarUrl || undefined },
    seo: { title: v.seoTitle || undefined, description: v.seoDescription || undefined, noindex: v.noindex },
    ...(extra.blocks ? { blocks: extra.blocks } : {}),
    ...(extra.theme ? { theme: extra.theme } : {}),
    ...(extra.replaceTheme ? { replaceTheme: extra.replaceTheme } : {}),
  };
}

/** Draft merged with the live form values, blocks and theme, rendered by the shared ProfileView. */
function previewDocument(base: ProfileDocument, v: Partial<Values>, blocks: ViewBlock[], theme: ThemeConfig): ViewDocument {
  return {
    ...base,
    header: {
      displayName: v.displayName?.trim() || "Your name",
      bio: v.bio?.trim() ?? "",
      avatarUrl: (v.avatarUrl && parseImageSrc(v.avatarUrl)) || undefined,
    },
    blocks,
    theme,
  };
}

const noopSubscribe = () => () => {};

const HEADER_INVALID = "Some profile details need attention. Fix the highlighted fields, then try again.";
const BLOCKS_INVALID = "Some blocks need attention. Fix the highlighted fields, then try again.";
const APPEARANCE_INVALID = "Some appearance settings need attention. Fix the highlighted fields, then try again.";

type Tab = "profile" | "content" | "design";
/** Below 75rem the editor and the preview take turns. */
type View = "edit" | "preview";

const card = "grid min-w-0 gap-4 rounded-cl-lg border border-cl-line bg-cl-surface p-4 ed-md:p-5";
const tabTrigger =
  "min-h-11 flex-none px-3 text-cl-ink-2 ed-lg:min-h-10 data-active:font-semibold data-active:text-cl-ink max-ed-md:flex-1 group-data-horizontal/tabs:after:bottom-[-1px]";

export function ProfileEditor({
  profile,
  label,
  links,
  switcher,
  manage,
  audience,
}: {
  profile: EditorProfile;
  /** The owner's name for this profile (only they see it). */
  label: string;
  links: WorkspaceLink[];
  /** The active-profile switcher (from 45rem; phones go back to the list), or null with one profile. */
  switcher: ReactNode;
  /** Address, name and deletion forms, shown at the end of the Profile section. */
  manage: ReactNode;
  /** Whether the Subscribe block can work here (email, the operator setting) and who is asking. */
  audience: { emailReady: boolean; visitorsKnown: boolean; subscribeEnabled: boolean; admin: boolean; ownerVerified: boolean };
}) {
  const [state, setState] = useState({
    revision: profile.revision,
    isPublished: profile.isPublished,
    everPublished: profile.everPublished,
    hasUnpublishedChanges: profile.hasUnpublishedChanges,
  });
  const [outcome, setOutcome] = useState<EditorOutcome>(null);
  // Why the content failed validation. Unlike the outcome, other operations (Unpublish) don't clear it:
  // only changed, reset or successfully saved content does, so Save and Publish stay blocked until then.
  const [invalidText, setInvalidText] = useState<string | null>(null);
  const [op, setOp] = useState<EditorOp | null>(null);
  const [busy, startTransition] = useTransition();
  // An unfinished draft, as it was saved: it opens in place of the last valid draft, with its problems shown.
  const kept = profile.incomplete;
  // The saved draft has problems; set by a save that kept it, cleared once a draft that validates is stored.
  const [needsAttention, setNeedsAttention] = useState(kept !== null);
  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    getValues,
    setError,
    setFocus,
    trigger,
    formState: { errors, isDirty },
  } = useForm<Values>({ resolver: zodResolver(formSchema), defaultValues: toValues(kept ?? headerOf(profile.draft)), shouldFocusError: false });
  const live = useWatch({ control });
  const noindex = useWatch({ control, name: "noindex" });
  const blocks = useBlockList(
    profile.draft.blocks,
    // shortcut: a kept image block gets its preview size from the library, so it shows as unchosen if the library failed to load; store sizes with kept blocks if that matters.
    kept ? { blocks: kept.blocks, errors: kept.issues.blockErrors, sizes: profile.media?.assets } : undefined,
  );
  const appearance = useAppearance(profile.draft.theme, profile.appearance, kept ? { theme: kept.theme, errors: kept.issues.fieldErrors } : undefined);
  const media = useMediaLibrary(profile.media);

  // Reopening an unfinished draft shows its header problems as a submit would, so each clears as its field is corrected.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !kept) return;
    restored.current = true;
    const avatarError = kept.issues.fieldErrors?.avatarUrl?.[0];
    void handleSubmit(
      () => {},
      () => {},
    )().then(() => avatarError && setError("avatarUrl", { type: "server", message: avatarError }));
  }, [kept, handleSubmit, setError]);
  const avatar = live.avatarUrl ?? "";
  const avatarUploaded = isMediaUrl(avatar);
  // Uploaded images chosen here (saved or not) can't be deleted from the library.
  const selectedInEditor = [avatar, appearance.theme?.background.imageUrl, ...blocks.images].filter((u): u is string => isMediaUrl(u));
  const [metadataDirty, setMetadataDirty] = useState(false);
  const metadataReset = useRef<(() => void) | null>(null);
  const dirty = isDirty || blocks.dirty || appearance.dirty;
  const navigationDirty = dirty || metadataDirty;
  const [protectedBlocks, setProtectedBlocks] = useState(profile.protectedBlocks);
  const locked = protectedBlocks > 0;
  const themeUnreadable = appearance.info.status === "invalid";
  const [tab, setTab] = useState<Tab>("content");
  const [view, setView] = useState<View>("edit");
  const [discardOpen, setDiscardOpen] = useState(false);
  const typing = useTyping();
  const previewRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);

  // False during SSR/hydration, true once hydrated; browser tests wait for it before typing.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);

  // Leaving with unsaved changes asks first. Pending holds the navigation to run if the person leaves anyway.
  const router = useRouter();
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const leaving = useRef(false);
  // The dialog has no trigger button, so focus goes back to whatever opened it (a link, the switcher).
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!navigationDirty) return;
    leaving.current = false;
    const confirm: ConfirmLeave = (proceed, origin) => {
      returnFocus.current = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setPendingLeave(() => proceed);
    };
    const warn = (e: BeforeUnloadEvent) => {
      if (!leaving.current) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (leaving.current) return;
      const link = guardedLink(e);
      if (!link) return;
      e.preventDefault();
      // Replaying the click keeps each link's own behavior (client-side or full navigation). A link in a
      // menu is gone once the menu closes, and a detached link can't navigate, so go to its address instead.
      confirm(() => (link.isConnected ? link.click() : router.push(link.pathname + link.search + link.hash)));
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", onClick, true);
    const unregister = registerLeaveGuard(confirm);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", onClick, true);
      unregister();
    };
  }, [navigationDirty, router]);

  /** Adopts the blocks and appearance the server stored for a draft that validated. */
  function loadSaved(nextBlocks: typeof profile.draft.blocks | null, theme: ThemeConfig, info: AppearanceInfo) {
    if (nextBlocks) blocks.load(nextBlocks);
    appearance.load(theme, info);
  }

  /**
   * Drops the unsaved edits before navigating: Next.js keeps a page it leaves
   * mounted but hidden, so the edits would otherwise come back with it. What
   * was last saved stays, unfinished or not (the form, the block list and the
   * appearance each keep their own saved values).
   */
  function leaveWithoutSaving() {
    const proceed = pendingLeave;
    setPendingLeave(null);
    leaving.current = true;
    reset(undefined, { keepIsSubmitted: needsAttention });
    // The saved values of an unfinished draft still have their problems.
    if (needsAttention) void trigger();
    metadataReset.current?.();
    setMetadataDirty(false);
    blocks.revert();
    appearance.revert();
    setOutcome(null);
    setInvalidText(null);
    proceed?.();
  }

  // A "needs attention" outcome describes the content it checked; once that content changes, the top
  // bar goes back to describing the draft (inline field errors keep their own detail).
  const contentKey = JSON.stringify(live);
  const basis = useRef({ contentKey, items: blocks.items, theme: appearance.theme });
  useEffect(() => {
    const changed = basis.current.contentKey !== contentKey || basis.current.items !== blocks.items || basis.current.theme !== appearance.theme;
    basis.current = { contentKey, items: blocks.items, theme: appearance.theme };
    if (changed && (invalidText !== null || (outcome?.kind === "error" && outcome.reason === "invalid"))) {
      setInvalidText(null);
      setOutcome((o) => (o?.kind === "error" && o.reason === "invalid" ? null : o));
    }
  }, [contentKey, blocks.items, appearance.theme, outcome, invalidText]);

  // Linked selection: mark the selected block in the preview and keep it in view there.
  // The shared renderer is untouched; its `.pp-block[data-block-id]` wrapper is the hook.
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll("[data-editor-selected]")) el.removeAttribute("data-editor-selected");
    if (!blocks.selected || tab !== "content") return;
    const el = root.querySelector<HTMLElement>(`.pp-block[data-block-id="${CSS.escape(blocks.selected)}"]`);
    if (!el) return;
    el.setAttribute("data-editor-selected", "");
    const pane = paneRef.current;
    if (!pane || pane.scrollHeight <= pane.clientHeight) return;
    const p = pane.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < p.top + 56 || r.bottom > p.bottom - 16) pane.scrollTop += r.top - p.top - p.height / 3;
  }, [blocks.selected, blocks.viewBlocks, tab, view]);

  /** Shows a section of the editor (and the editor itself on small screens). */
  function show(next: Tab) {
    setTab(next);
    setView("edit");
  }

  /**
   * Clears the last outcome synchronously, then runs the async work in a
   * transition. A rejected call (offline, server unreachable) becomes a
   * visible failure instead of an unhandled error; nothing is lost locally.
   */
  function act(kind: EditorOp, work: () => Promise<void>) {
    setOutcome(null);
    setOp(kind);
    startTransition(async () => {
      try {
        await work();
      } catch {
        setOutcome({ kind: "error", op: kind, reason: "network", text: NETWORK_ERROR[kind] });
      }
    });
  }

  /** Shows the Design section and focuses the given field once it is visible. */
  function revealAppearanceField(path: string) {
    appearance.focusField(path);
    show("design");
  }

  /** Shows the problems the server found on the fields they belong to, and the section holding them. */
  function showProblems(problems: { blockErrors?: BlockListErrors; fieldErrors?: Record<string, string[]> }, sent?: typeof blocks.items) {
    if (problems.blockErrors && sent) {
      blocks.applyServerErrors(problems.blockErrors, sent);
      show("content");
    }
    const avatarError = problems.fieldErrors?.avatarUrl?.[0];
    if (avatarError) {
      setError("avatarUrl", { type: "server", message: avatarError });
      show("profile");
    }
    const themeErrors = Object.keys(problems.fieldErrors ?? {}).filter((k) => k.startsWith("theme."));
    if (themeErrors.length) {
      appearance.applyServerErrors(problems.fieldErrors ?? {});
      revealAppearanceField(themeErrors[0].slice("theme.".length));
    }
  }

  function fail(
    kind: EditorOp,
    result: { error: string; code?: string; blockErrors?: BlockListErrors; fieldErrors?: Record<string, string[]> },
    sent?: typeof blocks.items,
  ) {
    showProblems(result, sent);
    const reason = result.code === "CONFLICT" ? "conflict" : result.code === "VALIDATION" ? "invalid" : "other";
    setOutcome({ kind: "error", op: kind, reason, text: result.error });
    // A refused save is a failed save; only publishing is held back until the content changes.
    if (reason === "invalid" && kind !== "save") setInvalidText(result.error);
  }

  /** Content failed a client check when publishing: report it and keep Publish blocked until the content changes. */
  function markInvalid(kind: EditorOp, text: string) {
    setOutcome({ kind: "error", op: kind, reason: "invalid", text });
    setInvalidText(text);
  }

  /** Client-side block and appearance checks before any request; the server re-validates everything. */
  function ready(kind: EditorOp): boolean {
    if (blocks.revealProblems()) {
      show("content");
      markInvalid(kind, BLOCKS_INVALID);
      return false;
    }
    if (appearance.pending.size) {
      revealAppearanceField([...appearance.pending][0]);
      markInvalid(kind, APPEARANCE_INVALID);
      return false;
    }
    return true;
  }

  /** Header fields failed client validation: show them, then focus the first once its section is visible. */
  const headerInvalid = (kind: EditorOp) => (fieldErrors: FieldErrors<Values>) => {
    show("profile");
    markInvalid(kind, HEADER_INVALID);
    const first = Object.keys(fieldErrors)[0] as keyof Values | undefined;
    if (first) requestAnimationFrame(() => setFocus(first));
  };

  /**
   * Saves the draft as it is. Content that wouldn't pass publishing is saved
   * too, as typed, and the server says what needs attention; only an
   * appearance field whose text isn't a value yet has nothing to save.
   */
  const saveWith = (values: Values, headerProblems = false) => {
    const [unfinished] = appearance.unfinished;
    if (unfinished) {
      revealAppearanceField(unfinished);
      return setOutcome({ kind: "error", op: "save", reason: "invalid", text: APPEARANCE_INVALID });
    }
    const sent = blocks.items;
    act("save", async () => {
      const patch = toPatch(values, { blocks: blocks.toInput(), theme: appearance.toInput() });
      const result = await saveDraftAction(profile.id, { expectedRevision: state.revision, patch });
      if (!result.ok) return fail("save", result, sent);
      const { needsAttention: issues } = result.data;
      if (issues) {
        // Kept exactly as typed: nothing is reloaded, and the form's own problems stay on their fields.
        reset(values, { keepErrors: true, keepIsSubmitted: true });
        blocks.markSaved(sent);
        appearance.markSaved();
        showProblems(issues, sent);
        // Lead to the first problem as a refused publish would: the header's section, else the block's own field.
        if (headerProblems) show("profile");
        else blocks.revealProblems();
      } else {
        reset(values);
        loadSaved(result.data.blocks, result.data.theme, result.data.appearance);
      }
      setNeedsAttention(issues !== null);
      // What a refused publish reported is now what the saved draft's own state says (or is fixed).
      setInvalidText(null);
      media.refresh();
      setState((st) => ({ ...st, revision: result.data.revision, hasUnpublishedChanges: true }));
      setOutcome({
        kind: "success",
        op: "save",
        text: issues || !state.isPublished ? "Draft saved." : "Draft saved. Publish to update your public page.",
      });
    });
  };
  // Header fields that fail the form's checks are saved as typed, with their messages shown.
  const save = handleSubmit(
    (values) => saveWith(values),
    () => saveWith(getValues(), true),
  );

  const publishWith = (values?: Values) => {
    if (values && !ready("publish")) return;
    const sent = blocks.items;
    const patch = values ? toPatch(values, { blocks: blocks.toInput(), theme: appearance.toInput() }) : undefined;
    act("publish", async () => {
      const result = await publishAction(profile.id, { expectedRevision: state.revision, ...(patch ? { patch } : {}) });
      if (!result.ok) return fail("publish", result, sent);
      if (values) reset(values);
      loadSaved(result.data.blocks, result.data.theme, result.data.appearance);
      media.refresh();
      setNeedsAttention(false);
      setState({ revision: result.data.revision, isPublished: true, everPublished: true, hasUnpublishedChanges: false });
      setOutcome({ kind: "success", op: "publish", text: "Published. Your public page is up to date." });
    });
  };

  const publish = () => (dirty ? handleSubmit((values) => publishWith(values), headerInvalid("publish"))() : publishWith());

  const unpublish = () =>
    act("unpublish", async () => {
      const result = await unpublishAction(profile.id);
      if (!result.ok) return fail("unpublish", result);
      setState((st) => ({ ...st, isPublished: false }));
      setOutcome({ kind: "success", op: "unpublish", text: "Unpublished. Your public page is no longer available." });
    });

  const revert = () =>
    act("discard", async () => {
      const result = await revertDraftAction(profile.id, { expectedRevision: state.revision });
      if (!result.ok) return fail("discard", result);
      reset(toValues(headerOf(result.data.draft)));
      loadSaved(result.data.draft.blocks, result.data.draft.theme, result.data.appearance);
      setInvalidText(null);
      setNeedsAttention(false);
      setProtectedBlocks(result.data.protectedBlocks);
      media.refresh();
      setState((st) => ({ ...st, revision: result.data.revision, hasUnpublishedChanges: false }));
      setOutcome({ kind: "success", op: "discard", text: "Draft changes discarded." });
    });

  /**
   * Confirmed replacement of a stored theme the editor can't carry.
   * Only offered without unsaved changes, so the header sent is the saved one.
   */
  const replaceAppearance = (presetId: PresetId) =>
    act("replace", async () => {
      const values = getValues();
      const result = await saveDraftAction(profile.id, { expectedRevision: state.revision, patch: toPatch(values, { replaceTheme: presetId }) });
      if (!result.ok) return fail("replace", result);
      // A replacement is all or nothing: the server never keeps one as an unfinished draft.
      if (result.data.needsAttention) return;
      loadSaved(null, result.data.theme, result.data.appearance);
      setNeedsAttention(false);
      media.refresh();
      setState((st) => ({ ...st, revision: result.data.revision, hasUnpublishedChanges: true }));
      setOutcome({ kind: "success", op: "replace", text: "Appearance replaced and draft saved." });
    });

  const st = editorStatus({
    pending: busy ? op : null,
    outcome,
    invalid: invalidText !== null,
    needsAttention,
    dirty,
    isPublished: state.isPublished,
    hasUnpublishedChanges: state.hasUnpublishedChanges,
    locked,
    themeUnreadable,
  });
  const canDiscard = state.everPublished && (state.hasUnpublishedChanges || dirty);
  const controlsOff = busy || locked;
  const headerIssues = Object.keys(errors).length;
  const blockIssues = blocks.items.filter((i) => blocks.errorsFor(i).attention).length;
  const hiddenBlocks = blocks.items.filter((i) => !i.visible).length;
  const retry = outcome?.kind === "error" && (outcome.reason === "network" || outcome.reason === "other") ? outcome.op : null;

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => show(v as Tab)}
      className="flex min-h-dvh min-w-0 flex-1 flex-col gap-0 ed-lg:h-dvh"
      data-hydrated={hydrated || undefined}
    >
      <header className="sticky top-0 z-30 border-b border-cl-line bg-cl-surface pt-[env(safe-area-inset-top)]">
        <div className="flex min-h-14 items-center gap-1 px-1.5 py-1.5 ed-md:gap-2 ed-md:px-4">
          <WorkspaceMenu links={links} className="ed-lg:hidden" />
          <Button asChild variant="ghost" size="icon" className="size-11 ed-lg:size-10">
            <Link href="/dashboard/profiles" aria-label="Back to profiles">
              <ChevronLeft aria-hidden="true" />
            </Link>
          </Button>
          <div className="flex min-w-0 flex-1 flex-col ed-md:flex-row ed-md:items-center ed-md:gap-5">
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-tight">{label}</h1>
              <p className="truncate font-mono text-xs text-cl-ink-2 max-ed-md:hidden" data-testid="editor-handle">
                /{profile.handle}
              </p>
            </div>
            <StatusLine st={st} />
          </div>

          {/* One set of controls: in the top bar from 45rem, a bottom action bar on phones. */}
          <div
            role="group"
            aria-label="Save and publish"
            className={[
              "flex items-center gap-2",
              "max-ed-md:fixed max-ed-md:inset-x-0 max-ed-md:bottom-0 max-ed-md:z-30 max-ed-md:border-t max-ed-md:border-cl-line max-ed-md:bg-cl-surface",
              "max-ed-md:px-3 max-ed-md:pt-2.5 max-ed-md:pb-[calc(0.625rem+env(safe-area-inset-bottom))]",
              // While the soft keyboard is likely open, the bar steps aside.
              typing ? "max-ed-md:hidden" : "",
            ].join(" ")}
          >
            <Button type="button" variant="outline" className="h-11 flex-[0.8] ed-md:hidden" onClick={() => setView(view === "edit" ? "preview" : "edit")}>
              {view === "edit" ? <Eye aria-hidden="true" /> : <Pencil aria-hidden="true" />}
              {view === "edit" ? "Preview" : "Edit"}
            </Button>
            {state.isPublished && (
              <Button asChild variant="ghost" className="h-10 max-[60rem]:hidden">
                <a href={`/${profile.handle}`} target="_blank" rel="noopener">
                  <SquareArrowOutUpRight aria-hidden="true" />
                  View live
                </a>
              </Button>
            )}
            <Button
              type="submit"
              form="header-form"
              variant="outline"
              className="h-10 max-ed-lg:h-11 max-ed-md:flex-1"
              disabled={!st.canSave}
              aria-busy={st.key === "saving" || undefined}
            >
              {st.key === "saving" && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}
              Save draft
            </Button>
            <Button
              type="button"
              className="h-10 max-ed-lg:h-11 max-ed-md:flex-1"
              onClick={publish}
              disabled={!st.canPublish}
              aria-busy={st.key === "publishing" || undefined}
            >
              {st.key === "publishing" && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}
              {st.publishLabel}
            </Button>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="size-11 ed-lg:size-10" aria-label="More profile actions">
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              {state.isPublished && (
                <DropdownMenuItem asChild className="min-h-11 ed-lg:min-h-9">
                  <a href={`/${profile.handle}`} target="_blank" rel="noopener">
                    <SquareArrowOutUpRight aria-hidden="true" />
                    View public page
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild className="min-h-11 ed-lg:min-h-9">
                <Link href={`/dashboard/profiles/${profile.id}/analytics`}>
                  <ChartLine aria-hidden="true" />
                  Analytics and QR code
                </Link>
              </DropdownMenuItem>
              {(state.isPublished || canDiscard) && <DropdownMenuSeparator />}
              {canDiscard && (
                <DropdownMenuItem className="min-h-11 ed-lg:min-h-9" disabled={busy} onSelect={() => setDiscardOpen(true)}>
                  Discard draft changes
                </DropdownMenuItem>
              )}
              {state.isPublished && (
                <DropdownMenuItem className="min-h-11 ed-lg:min-h-9" disabled={busy} onSelect={unpublish}>
                  Unpublish
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2 px-1.5 ed-md:px-4">
          <TabsList variant="line" aria-label="Editor sections" className="h-auto gap-1 p-0 max-ed-md:w-full">
            <TabsTrigger value="profile" className={tabTrigger}>
              Profile
              {headerIssues > 0 && <IssueCount n={headerIssues} />}
            </TabsTrigger>
            <TabsTrigger value="content" className={tabTrigger}>
              Content
              {blockIssues > 0 && <IssueCount n={blockIssues} />}
            </TabsTrigger>
            <TabsTrigger value="design" className={tabTrigger}>
              Design
              {appearance.issues.length > 0 && appearance.theme && (
                <span className="size-2 rounded-full bg-cl-warn" aria-label="needs attention" role="img" />
              )}
            </TabsTrigger>
          </TabsList>
          {switcher && <div className="ml-auto hidden py-1 ed-md:block">{switcher}</div>}
          <div role="group" aria-label="View" className={`${switcher ? "" : "ml-auto"} hidden gap-0.5 rounded-cl-md bg-cl-inset p-0.5 ed-md:max-ed-lg:flex`}>
            {(["edit", "preview"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className="min-h-11 rounded-cl-sm px-4 text-sm font-medium text-cl-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-cl-accent aria-pressed:bg-cl-surface aria-pressed:font-semibold aria-pressed:text-cl-ink aria-pressed:shadow-[0_0_0_1px_var(--cl-line-strong)]"
              >
                {v === "edit" ? "Edit" : "Preview"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="flex-1 ed-lg:grid ed-lg:min-h-0 ed-lg:grid-cols-[minmax(0,1fr)_minmax(22rem,27rem)] ed-lg:grid-rows-[auto_minmax(0,1fr)]">
        {/* One message area for both views: above the editor, and above the preview below 75rem. */}
        <div className="min-w-0 px-3 ed-md:px-6 ed-lg:col-start-1 ed-lg:row-start-1">
          <div className="mx-auto grid max-w-176 gap-4 has-[>:not(.sr-only)]:pt-4 ed-md:has-[>:not(.sr-only)]:pt-5">
            <Messages
              st={st}
              outcome={outcome}
              invalidText={invalidText}
              needsAttention={needsAttention}
              dirty={dirty}
              locked={locked}
              protectedBlocks={protectedBlocks}
              everPublished={state.everPublished}
              themeUnreadable={themeUnreadable}
              onOpenDesign={() => show("design")}
              onRetry={retry === "save" ? () => save() : retry === "publish" ? publish : null}
            />
          </div>
        </div>
        <div
          className={`min-w-0 px-3 py-4 max-ed-md:pb-28 ed-md:px-6 ed-md:py-5 ed-lg:col-start-1 ed-lg:row-start-2 ed-lg:overflow-y-auto ${view === "preview" ? "max-ed-lg:hidden" : ""}`}
        >
          <div className="mx-auto grid max-w-176 gap-4">
            {/* All sections stay mounted (Save submits #header-form); the inactive ones are hidden. */}
            <TabsContent value="profile" forceMount className="grid gap-5 data-[state=inactive]:hidden">
              <SectionHeading title="Profile" lede="Who this page belongs to, and how people find it." />
              <form id="header-form" onSubmit={save} noValidate>
                <fieldset disabled={busy} className="grid min-w-0 gap-5">
                <section aria-labelledby="identity-heading" className={card}>
                  <h3 id="identity-heading" className="text-sm font-semibold">
                    Identity
                  </h3>
                  <FormField id="displayName" label="Display name" error={errors.displayName?.message} {...register("displayName")} />
                  <div className="grid gap-1.5">
                    <Label htmlFor="bio">Bio</Label>
                    <Textarea
                      id="bio"
                      rows={4}
                      aria-invalid={errors.bio ? true : undefined}
                      aria-describedby={errors.bio ? "bio-error" : "bio-hint"}
                      {...register("bio")}
                    />
                    {errors.bio ? (
                      <p id="bio-error" className="text-xs text-destructive">
                        {errors.bio.message}
                      </p>
                    ) : (
                      <p id="bio-hint" className="text-xs text-muted-foreground">
                        Plain text, up to 300 characters. Line breaks are kept.
                      </p>
                    )}
                  </div>
                  <fieldset className="grid min-w-0 gap-4 rounded-cl-md border border-cl-line p-4" disabled={controlsOff}>
                    <legend className="px-1 text-sm font-medium">Avatar</legend>
                    <MediaPicker
                      kind="avatar"
                      id="avatar-upload"
                      label="Uploaded avatar"
                      value={avatarUploaded ? avatar : undefined}
                      onSelect={(url) => setValue("avatarUrl", url, { shouldDirty: true, shouldValidate: true })}
                      onClear={() => setValue("avatarUrl", "", { shouldDirty: true, shouldValidate: true })}
                      library={media}
                      selectedInEditor={selectedInEditor}
                      disabled={controlsOff}
                      error={avatarUploaded ? errors.avatarUrl?.message : undefined}
                    />
                    {!avatarUploaded && (
                      <FormField
                        id="avatarUrl"
                        label="Or use an image address"
                        type="url"
                        inputMode="url"
                        placeholder="https://…"
                        hint="An https:// image on another site. It's loaded from that site when people visit your page."
                        error={errors.avatarUrl?.message}
                        {...register("avatarUrl")}
                      />
                    )}
                  </fieldset>
                </section>
                <section aria-labelledby="search-heading" className={card}>
                  <h3 id="search-heading" className="text-sm font-semibold">
                    Search and sharing
                  </h3>
                  <FormField
                    id="seoTitle"
                    label="Page title (optional)"
                    hint="Defaults to your display name."
                    error={errors.seoTitle?.message}
                    {...register("seoTitle")}
                  />
                  <FormField
                    id="seoDescription"
                    label="Description (optional)"
                    hint="Defaults to your bio."
                    error={errors.seoDescription?.message}
                    {...register("seoDescription")}
                  />
                  <div className="flex min-h-11 items-center gap-3">
                    <Switch id="noindex" checked={noindex} onCheckedChange={(v) => setValue("noindex", v, { shouldDirty: true })} />
                    <Label htmlFor="noindex">Hide from search engines</Label>
                  </div>
                </section>
                </fieldset>
              </form>
              <MetadataGuard.Provider value={{ changed: setMetadataDirty, registerReset: (reset) => { metadataReset.current = reset; return () => { metadataReset.current = null; }; } }}>{manage}</MetadataGuard.Provider>
            </TabsContent>

            <TabsContent value="content" forceMount className="grid gap-5 data-[state=inactive]:hidden">
              <SectionHeading title="Content" lede="Visitors see these blocks in order. Drag a handle, or focus it and use the arrow keys." />
              <AudienceContext value={audience}>
                <BlockListEditor list={blocks} disabled={controlsOff} media={{ library: media, selectedInEditor }} />
              </AudienceContext>
            </TabsContent>

            <TabsContent value="design" forceMount className="grid gap-5 data-[state=inactive]:hidden">
              <SectionHeading title="Design" lede="How your public page looks. These settings never change the dashboard." />
              <AppearanceEditor
                list={appearance}
                disabled={controlsOff}
                canReplace={!dirty}
                onReplace={replaceAppearance}
                media={media}
                selectedInEditor={selectedInEditor}
              />
            </TabsContent>
          </div>
        </div>

        <aside
          ref={paneRef}
          aria-labelledby="preview-heading"
          className={`min-w-0 bg-cl-inset max-ed-md:pb-28 ed-lg:col-start-2 ed-lg:row-span-2 ed-lg:row-start-1 ed-lg:overflow-y-auto ed-lg:border-l ed-lg:border-cl-line ${view === "edit" ? "max-ed-lg:hidden" : ""}`}
        >
          <div className="sticky top-0 z-10 flex min-h-12 items-center gap-2 bg-cl-inset px-4">
            <h2 id="preview-heading" className="text-sm font-semibold">
              Preview
            </h2>
            <span className="truncate text-sm text-cl-ink-2">
              Draft
              {hiddenBlocks > 0 && ` · ${hiddenBlocks} hidden ${hiddenBlocks === 1 ? "block" : "blocks"} not shown`}
            </span>
          </div>
          <div className="px-3 pt-1 pb-6 ed-md:px-4">
            <div ref={previewRef} className="mx-auto max-w-sm overflow-hidden rounded-cl-lg ring-1 ring-cl-line" data-testid="profile-preview">
              <ProfileView
                document={previewDocument(profile.draft, live, blocks.viewBlocks, appearance.previewTheme)}
                verified={profile.verified}
                mode="preview"
              />
            </div>
          </div>
        </aside>
      </main>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard draft changes?</AlertDialogTitle>
            <AlertDialogDescription>Your draft goes back to what is currently published. This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={revert}>Discard changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingLeave !== null} onOpenChange={(open) => !open && setPendingLeave(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>You have unsaved changes in this profile. If you leave now, they&apos;re lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={leaveWithoutSaving}>Leave without saving</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}

/**
 * True while a soft keyboard is open: a text field has focus and the visual
 * viewport has shrunk. A hardware keyboard (or none) never hides the action bar.
 */
function useTyping() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const isText = (el: Element | null) =>
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "file", "range", "color"].includes(el.type));
    const check = () => setTyping(isText(document.activeElement) && vv.height < window.innerHeight * 0.8);
    // focusout fires before the next element is focused; check once focus has settled.
    const later = () => requestAnimationFrame(check);
    vv.addEventListener("resize", check);
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", later);
    return () => {
      vv.removeEventListener("resize", check);
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", later);
    };
  }, []);
  return typing;
}

function SectionHeading({ title, lede }: { title: string; lede: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-cl-ink-2">{lede}</p>
    </div>
  );
}

function IssueCount({ n }: { n: number }) {
  return (
    <span className="rounded-cl-sm border border-cl-danger px-1 text-xs leading-4 font-semibold text-cl-danger">
      {n}
      <span className="sr-only"> {n === 1 ? "problem" : "problems"} to fix</span>
    </span>
  );
}

const TONE = { neutral: "text-cl-ink-2", ok: "text-cl-ok", warn: "text-cl-warn", bad: "text-cl-danger" } as const;

/** Top-bar state: an icon and words, never colour alone. Announcements come from the message area. */
function StatusLine({ st }: { st: EditorStatus }) {
  const icon = {
    spinner: <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />,
    check: <CircleCheck className="size-3.5" aria-hidden="true" />,
    dot: <Dot className="-mx-1 size-5" aria-hidden="true" />,
    alert: <CircleAlert className="size-3.5" aria-hidden="true" />,
    lock: <Lock className="size-3.5" aria-hidden="true" />,
  }[st.icon];
  return (
    <p className={`flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap ${TONE[st.tone]}`} data-testid="profile-status" data-state={st.key}>
      {icon}
      <span data-testid={st.key === "unsaved" ? "unsaved-indicator" : undefined}>{st.label}</span>
    </p>
  );
}

const banner = "grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-2 rounded-cl-md border px-4 py-3 text-sm";

/** The message area: what happened, why, and the way forward. */
function Messages({
  st,
  outcome,
  invalidText,
  needsAttention,
  dirty,
  locked,
  protectedBlocks,
  everPublished,
  themeUnreadable,
  onOpenDesign,
  onRetry,
}: {
  st: EditorStatus;
  outcome: EditorOutcome;
  invalidText: string | null;
  needsAttention: boolean;
  dirty: boolean;
  locked: boolean;
  protectedBlocks: number;
  everPublished: boolean;
  themeUnreadable: boolean;
  onOpenDesign: () => void;
  onRetry: (() => void) | null;
}) {
  // A later operation's feedback replaces the outcome, but unresolved validation problems stay reported.
  const error = outcome?.kind === "error" ? outcome : invalidText ? ({ op: "publish", reason: "invalid", text: invalidText } as const) : null;
  // Validation feedback names what didn't happen, so a failed save never reads like a blocked publish.
  const refused = error?.reason !== "invalid" ? null : error.op === "publish" ? "Not published. " : error.op === "save" ? "Not saved. " : null;
  // A success message describes the last action; once there are new edits, "Unsaved changes" is the state.
  const success = outcome?.kind === "success" && (!dirty || outcome.op === "unpublish") ? outcome.text : "";
  return (
    <>
      {locked && (
        <div role="note" className={`${banner} border-cl-warn/40 bg-cl-warn-wash`} data-testid="protected-blocks">
          <Lock className="mt-0.5 size-4 text-cl-warn" aria-hidden="true" />
          <p>
            This draft contains {protectedBlocks === 1 ? "a block" : `${protectedBlocks} blocks`} that this version of COVALink can&apos;t
            edit without losing data. To protect {protectedBlocks === 1 ? "it" : "them"}, saving and publishing are turned off.
            {everPublished && " Discarding draft changes restores your published version."}
          </p>
        </div>
      )}
      {themeUnreadable && (
        <div role="note" className={`${banner} border-cl-warn/40 bg-cl-warn-wash`} data-testid="publish-blocked">
          <Lock className="mt-0.5 size-4 text-cl-warn" aria-hidden="true" />
          <p>
            <strong className="font-semibold">Publishing is turned off</strong> until you replace the saved appearance in Design. Your content
            can still be edited and saved, and your public page is unchanged.
          </p>
          <div className="col-start-2">
            <Button type="button" variant="outline" className="h-10 max-ed-lg:h-11" onClick={onOpenDesign}>
              Open Design
            </Button>
          </div>
        </div>
      )}

      {needsAttention && (
        <div role="note" className={`${banner} border-cl-warn/40 bg-cl-warn-wash`} data-testid="draft-needs-attention">
          <CircleAlert className="mt-0.5 size-4 text-cl-warn" aria-hidden="true" />
          <p>
            <strong className="font-semibold">Your draft is saved, but it can&apos;t be published yet.</strong> Fix the highlighted problems,
            then publish. Visitors never see an unfinished draft.
          </p>
        </div>
      )}

      {/* Always rendered so screen readers announce changes to the live region. */}
      <div role="alert" aria-live="assertive" className={error ? `${banner} border-cl-danger/40 bg-cl-danger-wash` : "sr-only"}>
        {error && (
          <>
            <CircleAlert className="mt-0.5 size-4 text-cl-danger" aria-hidden="true" />
            <p>
              {st.key === "conflict" && <strong className="font-semibold">Someone or something changed this profile after you opened it. </strong>}
              {refused && <strong className="font-semibold">{refused}</strong>}
              {error.text}
              {error.op === "unpublish" && " Check the public page before retrying Unpublish from More profile actions."}
              {error.op === "discard" && " Your local edits are still here. Retry Discard draft changes from More profile actions."}
              {error.op === "replace" && " Your local edits are still here. Open Design and retry replacing the appearance."}
            </p>
            {(st.key === "conflict" || onRetry) && (
              <div className="col-start-2 flex flex-wrap gap-2">
                {st.key === "conflict" ? (
                  <Button type="button" className="h-10 max-ed-lg:h-11" onClick={() => navigateWithGuard(() => window.location.reload())}>
                    <RotateCw aria-hidden="true" />
                    Reload latest version
                  </Button>
                ) : (
                  onRetry && (
                    <Button type="button" variant="outline" className="h-10 max-ed-lg:h-11" onClick={onRetry}>
                      <RotateCw aria-hidden="true" />
                      Try again
                    </Button>
                  )
                )}
              </div>
            )}
          </>
        )}
      </div>
      <p
        role="status"
        aria-live="polite"
        className={success ? `${banner} grid-cols-1 border-cl-ok/40 bg-cl-ok-wash font-medium` : "sr-only"}
        data-testid="editor-status"
      >
        {success}
      </p>
    </>
  );
}
