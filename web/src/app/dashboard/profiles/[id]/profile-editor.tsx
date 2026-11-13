"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { AppearanceEditor, useAppearance, type AppearanceInfo } from "@/components/editor/appearance-editor";
import { BlockListEditor, useBlockList } from "@/components/editor/block-list-editor";
import { MediaPicker, useMediaLibrary } from "@/components/editor/media-picker";
import type { ViewBlock } from "@/components/profile/blocks";
import { ProfileView, type ViewDocument } from "@/components/profile/profile-view";
import { ProfileStatusBadge } from "@/components/profile-status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { BlockInput } from "@/features/blocks/input";
import { publishAction, revertDraftAction, saveDraftAction, unpublishAction } from "@/features/profiles/actions";
import type { ProfileDocument } from "@/features/profiles/document";
import type { MediaLibrary } from "@/features/media/types";
import type { DraftPatchInput } from "@/features/profiles/draft-input";
import type { PresetId, ThemeConfig, ThemeInput } from "@/features/themes/schema";
import type { BlockListErrors } from "@/lib/errors";
import { guardedLink, navigateWithGuard, registerLeaveGuard, type ConfirmLeave } from "@/lib/navigation-guard";
import { isMediaUrl, parseImageSrc } from "@/lib/validation/media";

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

function toValues(doc: ProfileDocument): Values {
  return {
    displayName: doc.header.displayName,
    bio: doc.header.bio,
    avatarUrl: doc.header.avatarUrl ?? "",
    seoTitle: doc.settings.seo.title ?? "",
    seoDescription: doc.settings.seo.description ?? "",
    noindex: doc.settings.seo.noindex,
  };
}

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

const BLOCKS_INVALID = "Some blocks need attention. Fix the highlighted fields, then try again.";
const APPEARANCE_INVALID = "Some appearance settings need attention. Fix the highlighted fields, then try again.";

type Tab = "content" | "appearance";

type Status = { kind: "success" | "error"; text: string; conflict?: boolean } | null;

export function ProfileEditor({ profile }: { profile: EditorProfile }) {
  const [state, setState] = useState({
    revision: profile.revision,
    isPublished: profile.isPublished,
    everPublished: profile.everPublished,
    hasUnpublishedChanges: profile.hasUnpublishedChanges,
  });
  const [status, setStatus] = useState<Status>(null);
  const [busy, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    getValues,
    setError,
    formState: { errors, isDirty },
  } = useForm<Values>({ resolver: zodResolver(formSchema), defaultValues: toValues(profile.draft) });
  const live = useWatch({ control });
  const noindex = useWatch({ control, name: "noindex" });
  const blocks = useBlockList(profile.draft.blocks);
  const appearance = useAppearance(profile.draft.theme, profile.appearance);
  const media = useMediaLibrary(profile.media);
  const avatar = live.avatarUrl ?? "";
  const avatarUploaded = isMediaUrl(avatar);
  // Uploaded images chosen here (saved or not) can't be deleted from the library.
  const selectedInEditor = [avatar, appearance.theme?.background.imageUrl, ...blocks.images].filter((u): u is string => isMediaUrl(u));
  const dirty = isDirty || blocks.dirty || appearance.dirty;
  const [protectedBlocks, setProtectedBlocks] = useState(profile.protectedBlocks);
  const locked = protectedBlocks > 0;
  const themeUnreadable = appearance.info.status === "invalid";
  const [tab, setTab] = useState<Tab>("content");

  // False during SSR/hydration, true once hydrated; browser tests wait for it before typing.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);

  // Leaving with unsaved changes asks first. Pending holds the navigation to run if the person leaves anyway.
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const leaving = useRef(false);
  // The dialog has no trigger button, so focus goes back to whatever opened it (a link, the switcher).
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!dirty) return;
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
      // Replaying the click keeps each link's own behavior (client-side or full navigation).
      confirm(() => link.click());
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", onClick, true);
    const unregister = registerLeaveGuard(confirm);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", onClick, true);
      unregister();
    };
  }, [dirty]);

  // The blocks and appearance the server last stored (the form keeps its own saved values).
  const [saved, setSaved] = useState({ blocks: profile.draft.blocks, theme: profile.draft.theme, appearance: profile.appearance });

  function loadSaved(nextBlocks: typeof profile.draft.blocks | null, theme: ThemeConfig, info: AppearanceInfo) {
    if (nextBlocks) blocks.load(nextBlocks);
    appearance.load(theme, info);
    setSaved((s) => ({ blocks: nextBlocks ?? s.blocks, theme, appearance: info }));
  }

  /**
   * Drops the unsaved edits before navigating: Next.js keeps a page it leaves
   * mounted but hidden, so the edits would otherwise come back with it.
   */
  function leaveWithoutSaving() {
    const proceed = pendingLeave;
    setPendingLeave(null);
    leaving.current = true;
    reset();
    loadSaved(saved.blocks, saved.theme, saved.appearance);
    setStatus(null);
    proceed?.();
  }

  /**
   * Clears the message synchronously, then runs the async work in a transition.
   * (State set inside an async transition before its first await commits only when
   * the whole transition ends, after the updates made later, so it would erase them.)
   */
  function act(op: () => Promise<void>) {
    setStatus(null);
    startTransition(op);
  }

  /** Shows the Appearance tab and focuses the given field once it is visible. */
  function revealAppearanceField(path: string) {
    appearance.focusField(path);
    setTab("appearance");
  }

  function fail(
    result: { error: string; code?: string; blockErrors?: BlockListErrors; fieldErrors?: Record<string, string[]> },
    sent?: typeof blocks.items,
  ) {
    if (result.blockErrors && sent) blocks.applyServerErrors(result.blockErrors, sent);
    const avatarError = result.fieldErrors?.avatarUrl?.[0];
    if (avatarError) {
      setError("avatarUrl", { type: "server", message: avatarError });
      setTab("content");
    }
    const themeErrors = Object.keys(result.fieldErrors ?? {}).filter((k) => k.startsWith("theme."));
    if (themeErrors.length) {
      appearance.applyServerErrors(result.fieldErrors ?? {});
      revealAppearanceField(themeErrors[0].slice("theme.".length));
    }
    setStatus({ kind: "error", text: result.error, conflict: result.code === "CONFLICT" });
  }

  /** Client-side block and appearance checks before any request; the server re-validates everything. */
  function ready(): boolean {
    if (blocks.revealProblems()) {
      setTab("content");
      setStatus({ kind: "error", text: BLOCKS_INVALID });
      return false;
    }
    if (appearance.pending.size) {
      revealAppearanceField([...appearance.pending][0]);
      setStatus({ kind: "error", text: APPEARANCE_INVALID });
      return false;
    }
    return true;
  }

  const save = handleSubmit((values) => {
    if (!ready()) return;
    const sent = blocks.items;
    act(async () => {
      const patch = toPatch(values, { blocks: blocks.toInput(), theme: appearance.toInput() });
      const result = await saveDraftAction(profile.id, { expectedRevision: state.revision, patch });
      if (!result.ok) return fail(result, sent);
      reset(values);
      loadSaved(result.data.blocks, result.data.theme, result.data.appearance);
      media.refresh();
      setState((st) => ({ ...st, revision: result.data.revision, hasUnpublishedChanges: true }));
      setStatus({
        kind: "success",
        text: state.isPublished ? "Draft saved. Publish to update your public page." : "Draft saved.",
      });
    });
  });

  const publishWith = (values?: Values) => {
    if (values && !ready()) return;
    const sent = blocks.items;
    const patch = values ? toPatch(values, { blocks: blocks.toInput(), theme: appearance.toInput() }) : undefined;
    act(async () => {
      const result = await publishAction(profile.id, { expectedRevision: state.revision, ...(patch ? { patch } : {}) });
      if (!result.ok) return fail(result, sent);
      if (values) reset(values);
      loadSaved(result.data.blocks, result.data.theme, result.data.appearance);
      media.refresh();
      setState({ revision: result.data.revision, isPublished: true, everPublished: true, hasUnpublishedChanges: false });
      setStatus({ kind: "success", text: "Published. Your public page is up to date." });
    });
  };

  const publish = () => (dirty ? handleSubmit((values) => publishWith(values))() : publishWith());

  const unpublish = () =>
    act(async () => {
      const result = await unpublishAction(profile.id);
      if (!result.ok) return fail(result);
      setState((st) => ({ ...st, isPublished: false }));
      setStatus({ kind: "success", text: "Unpublished. Your public page is no longer available." });
    });

  const revert = () =>
    act(async () => {
      const result = await revertDraftAction(profile.id, { expectedRevision: state.revision });
      if (!result.ok) return fail(result);
      reset(toValues(result.data.draft));
      loadSaved(result.data.draft.blocks, result.data.draft.theme, result.data.appearance);
      setProtectedBlocks(result.data.protectedBlocks);
      media.refresh();
      setState((st) => ({ ...st, revision: result.data.revision, hasUnpublishedChanges: false }));
      setStatus({ kind: "success", text: "Draft changes discarded." });
    });

  /**
   * Confirmed replacement of a stored theme the editor can't carry.
   * Only offered without unsaved changes, so the header sent is the saved one.
   */
  const replaceAppearance = (presetId: PresetId) =>
    act(async () => {
      const values = getValues();
      const result = await saveDraftAction(profile.id, { expectedRevision: state.revision, patch: toPatch(values, { replaceTheme: presetId }) });
      if (!result.ok) return fail(result);
      loadSaved(null, result.data.theme, result.data.appearance);
      media.refresh();
      setState((st) => ({ ...st, revision: result.data.revision, hasUnpublishedChanges: true }));
      setStatus({ kind: "success", text: "Appearance replaced and draft saved." });
    });

  const upToDate = state.isPublished && !state.hasUnpublishedChanges && !dirty;
  const canDiscard = state.everPublished && (state.hasUnpublishedChanges || dirty);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]" data-hydrated={hydrated || undefined}>
      <section aria-labelledby="content-heading" className="grid content-start gap-5 rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="content-heading" className="text-sm font-medium">
            Content
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {dirty && (
              <span className="text-xs font-medium text-amber-700 dark:text-amber-400" data-testid="unsaved-indicator">
                Unsaved changes
              </span>
            )}
            <ProfileStatusBadge isPublished={state.isPublished} hasUnpublishedChanges={state.hasUnpublishedChanges} />
          </div>
        </div>

        {locked && (
          <div role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" data-testid="protected-blocks">
            This draft contains {protectedBlocks === 1 ? "a block" : `${protectedBlocks} blocks`} that this version of COVALink
            can&apos;t edit without losing data. To protect {protectedBlocks === 1 ? "it" : "them"}, saving and publishing are
            turned off.
            {state.everPublished && " Discarding draft changes restores your published version."}
          </div>
        )}

        {/* Both panels stay mounted (the Save button submits #header-form); the inactive one is hidden. */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-5">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="appearance">
              Appearance
              {appearance.issues.length > 0 && appearance.theme && (
                <span className="size-2 rounded-full bg-amber-500" aria-label="needs attention" role="img" />
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="content" forceMount className="grid gap-5 data-[state=inactive]:hidden">
            <h3 className="text-sm font-medium">Header &amp; search</h3>
            <form id="header-form" onSubmit={save} noValidate className="grid gap-4">
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
              <fieldset className="grid min-w-0 gap-4 rounded-lg border p-4" disabled={busy || locked}>
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
                  disabled={busy || locked}
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
              <fieldset className="grid gap-4 rounded-lg border p-4">
                <legend className="px-1 text-sm font-medium">Search &amp; sharing</legend>
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
                <div className="flex items-center gap-3">
                  <Switch
                    id="noindex"
                    checked={noindex}
                    onCheckedChange={(v) => setValue("noindex", v, { shouldDirty: true })}
                  />
                  <Label htmlFor="noindex">Hide from search engines</Label>
                </div>
              </fieldset>
            </form>

            <BlockListEditor list={blocks} disabled={busy || locked} media={{ library: media, selectedInEditor }} />
          </TabsContent>
          <TabsContent value="appearance" forceMount className="grid gap-5 data-[state=inactive]:hidden">
            <AppearanceEditor
              list={appearance}
              disabled={busy || locked}
              canReplace={!dirty}
              onReplace={replaceAppearance}
              media={media}
              selectedInEditor={selectedInEditor}
            />
          </TabsContent>
        </Tabs>

        {themeUnreadable && (
          <p className="text-sm text-muted-foreground" data-testid="publish-blocked">
            Publishing is turned off until you replace the saved appearance (Appearance tab).
          </p>
        )}

        <FormAlert message={status?.kind === "error" ? status.text : null} />
        {status?.conflict && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => navigateWithGuard(() => window.location.reload())}
          >
            Reload latest version
          </Button>
        )}
        {/* A success message describes the last action; once there are new edits, "Unsaved changes" is the state. */}
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground" data-testid="editor-status">
          {status?.kind === "success" && !dirty ? status.text : ""}
        </p>

        <AlertDialog open={pendingLeave !== null} onOpenChange={(open) => !open && setPendingLeave(null)}>
          <AlertDialogContent
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              returnFocus.current?.focus();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
              <AlertDialogDescription>
                You have unsaved changes in this profile. If you leave now, they&apos;re lost.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction onClick={leaveWithoutSaving}>Leave without saving</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" form="header-form" variant="outline" disabled={busy || locked || !dirty}>
            Save draft
          </Button>
          <Button type="button" onClick={publish} disabled={busy || locked || upToDate || themeUnreadable}>
            {upToDate ? "Published" : state.isPublished ? "Publish changes" : "Publish"}
          </Button>
          {state.isPublished && (
            <Button type="button" variant="ghost" onClick={unpublish} disabled={busy}>
              Unpublish
            </Button>
          )}
          {canDiscard && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="ghost" disabled={busy}>
                  Discard draft changes
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Discard draft changes?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Your draft goes back to what is currently published. This can&apos;t be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep editing</AlertDialogCancel>
                  <AlertDialogAction onClick={revert}>Discard changes</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {state.isPublished && (
            <Button asChild variant="link">
              <a href={`/${profile.handle}`} target="_blank" rel="noopener">
                View public page
              </a>
            </Button>
          )}
        </div>
      </section>

      <section aria-labelledby="preview-heading" className="grid content-start gap-2">
        <h2 id="preview-heading" className="text-sm font-medium">
          Preview <span className="font-normal text-muted-foreground">(draft)</span>
        </h2>
        <div className="overflow-hidden rounded-2xl border shadow-sm lg:sticky lg:top-4" data-testid="profile-preview">
          <ProfileView
            document={previewDocument(profile.draft, live, blocks.viewBlocks, appearance.previewTheme)}
            verified={profile.verified}
            mode="preview"
          />
        </div>
      </section>
    </div>
  );
}
