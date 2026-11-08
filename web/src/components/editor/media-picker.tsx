"use client";

import { ImageUp, Trash2 } from "lucide-react";
import { useRef, useState, useTransition } from "react";
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
import { deleteMediaAction, listMediaAction } from "@/features/media/actions";
import { ACCEPT_TYPES, formatBytes, MAX_INPUT_BYTES, OUTPUT_BOX, type MediaKind } from "@/features/media/constants";
import type { MediaAssetView, MediaLibrary, MediaUsage } from "@/features/media/types";

/**
 * Upload and choose uploaded images. One library per editor
 * (`useMediaLibrary`), shown per kind by `MediaPicker`. Uploads stream the
 * raw file to `POST /api/media`; the server decides whether it is an image
 * and re-encodes it. Deletion is confirmed, and an image that is in use
 * (by a saved draft or a published page, or selected but not yet saved
 * here) explains why it can't be deleted instead. Image blocks use the
 * `background` library under their own wording and test id. Every
 * control is a 44 px target below `sm`.
 */

type UploadResult = { ok: true; asset: MediaAssetView; usage: MediaUsage } | { ok: false; error: string };

export function useMediaLibrary(initial: MediaLibrary | null) {
  const [library, setLibrary] = useState(initial);
  const [loadFailed, setLoadFailed] = useState(initial === null);
  const [, startTransition] = useTransition();
  return {
    library,
    loadFailed,
    /** Re-reads the library (usage changes after saves and publishes). */
    refresh() {
      startTransition(async () => {
        const r = await listMediaAction();
        if (r.ok) {
          setLibrary(r.data);
          setLoadFailed(false);
        } else if (!library) setLoadFailed(true);
      });
    },
    added(asset: MediaAssetView, usage: MediaUsage) {
      setLibrary((l) => ({ ...usage, assets: [asset, ...(l?.assets ?? []).filter((a) => a.id !== asset.id)] }));
    },
    /** Deletes an image; returns the refusal message, or null once it is gone. */
    async remove(id: string): Promise<string | null> {
      const r = await deleteMediaAction(id);
      if (!r.ok) return r.error;
      setLibrary(r.data);
      return null;
    },
  };
}

export type MediaLibraryState = ReturnType<typeof useMediaLibrary>;

/** Streams one file to the upload endpoint with progress (XHR: fetch has no upload progress). */
function uploadFile(file: File, kind: MediaKind, onProgress: (pct: number) => void): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/media?kind=${kind}`);
    xhr.setRequestHeader("x-upload-filename", encodeURIComponent(file.name.slice(0, 120)));
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const body = xhr.response as { asset?: MediaAssetView; usage?: MediaUsage; error?: string } | null;
      if (xhr.status === 201 && body?.asset && body.usage) resolve({ ok: true, asset: body.asset, usage: body.usage });
      else resolve({ ok: false, error: body?.error ?? "The upload failed. Please try again." });
    };
    xhr.onerror = () => resolve({ ok: false, error: "The upload failed. Check your connection and try again." });
    xhr.send(file);
  });
}

export type MediaNouns = { noun: string; plural: string };

const KIND_TEXT: Record<MediaKind, MediaNouns> = {
  avatar: { noun: "avatar", plural: "avatars" },
  background: { noun: "background image", plural: "background images" },
};

function usageText(a: MediaAssetView, selectedHere: boolean): string[] {
  const out = a.usedBy.map((u) => {
    const where = [u.draft && "saved draft", u.published && "published page"].filter(Boolean).join(" and ");
    return `/${u.handle} (${where})`;
  });
  if (selectedHere) out.push("this editor (selected, not saved yet)");
  return out;
}

function DeleteImage({
  asset,
  selectedHere,
  disabled,
  onDelete,
}: {
  asset: MediaAssetView;
  selectedHere: boolean;
  disabled: boolean;
  onDelete: () => void;
}) {
  const uses = usageText(asset, selectedHere);
  const name = asset.originalName ?? "this image";
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="absolute top-1 right-1 size-7 opacity-90 max-sm:size-11"
          aria-label={`Delete ${name}`}
          disabled={disabled}
          data-testid="media-delete"
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        {uses.length > 0 ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>This image can&apos;t be deleted yet</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="grid gap-2">
                  <p>It&apos;s still used by:</p>
                  <ul className="list-disc pl-5" data-testid="media-in-use">
                    {uses.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                  <p>Choose a different image there (and publish, if it&apos;s on your public page), then delete it.</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Close</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this image?</AlertDialogTitle>
              <AlertDialogDescription>
                {name} is removed from your library and its address stops working. Browsers that already saved a copy may
                still show it for a while. This can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction onClick={onDelete}>Delete image</AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function MediaPicker({
  kind,
  id,
  label,
  value,
  onSelect,
  onClear,
  library,
  selectedInEditor,
  disabled,
  error,
  nouns,
  testId = kind,
}: {
  kind: MediaKind;
  /** Id of the upload button (the field's focus target). */
  id: string;
  label: string;
  /** The selected image's URL, if it is an uploaded one. */
  value: string | undefined;
  /** The chosen image's URL and its library entry (size, name). */
  onSelect: (url: string, asset: MediaAssetView) => void;
  onClear?: () => void;
  library: MediaLibraryState;
  /** URLs chosen in the editor but not necessarily saved; they can't be deleted. */
  selectedInEditor: readonly string[];
  disabled: boolean;
  error?: string;
  /** Wording for the images; defaults to the kind's ("avatar", "background image"). */
  nouns?: MediaNouns;
  /** Suffix of the picker's test ids (`media-{testId}`, `media-file-{testId}`); defaults to the kind. */
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [deleting, startDelete] = useTransition();
  const text = nouns ?? KIND_TEXT[kind];
  const items = (library.library?.assets ?? []).filter((a) => a.kind === kind);
  const uploading = progress !== null;
  const hintId = `${id}-hint`;
  const shownError = error ?? (message?.kind === "error" ? message.text : undefined);

  async function upload(file: File) {
    setMessage(null);
    if (file.size > MAX_INPUT_BYTES) {
      setMessage({ kind: "error", text: "This file is larger than 5 MB. Choose a smaller image." });
      return;
    }
    setProgress(0);
    const r = await uploadFile(file, kind, setProgress);
    setProgress(null);
    if (!r.ok) {
      setMessage({ kind: "error", text: r.error });
      return;
    }
    library.added(r.asset, r.usage);
    onSelect(r.asset.url, r.asset);
    setMessage({ kind: "success", text: `Uploaded and selected. Save or publish to use it on your page.` });
  }

  function remove(asset: MediaAssetView) {
    setMessage(null);
    startDelete(async () => {
      const refusal = await library.remove(asset.id);
      setMessage(refusal ? { kind: "error", text: refusal } : { kind: "success", text: "Image deleted." });
    });
  }

  return (
    <div className="grid min-w-0 gap-2" role="group" aria-labelledby={`${id}-label`} data-testid={`media-${testId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span id={`${id}-label`} className="text-sm font-medium">
          {label}
        </span>
        {library.library && (
          <span className="text-xs text-muted-foreground" data-testid="media-quota">
            {formatBytes(library.library.usedBytes)} of {formatBytes(library.library.quotaBytes)} used
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept={ACCEPT_TYPES}
          hidden
          data-testid={`media-file-${testId}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
        <Button
          id={id}
          type="button"
          variant="outline"
          size="sm"
          className="max-sm:min-h-11"
          disabled={disabled || uploading}
          aria-describedby={[hintId, shownError && `${id}-error`].filter(Boolean).join(" ")}
          onClick={() => input.current?.click()}
        >
          <ImageUp aria-hidden="true" />
          {uploading ? `Uploading… ${progress}%` : `Upload ${text.noun}`}
        </Button>
        {value && onClear && (
          <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-11" disabled={disabled} onClick={onClear}>
            Remove {text.noun}
          </Button>
        )}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        JPEG, PNG or WebP, up to 5 MB. It&apos;s converted to WebP at most {OUTPUT_BOX[kind]} × {OUTPUT_BOX[kind]} px, and
        camera details such as location are removed.
      </p>
      {uploading && (
        <div
          role="progressbar"
          aria-label={`Uploading ${text.noun}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {shownError && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive" data-testid="media-error">
          {shownError}
        </p>
      )}
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground" data-testid="media-status">
        {message?.kind === "success" ? message.text : ""}
      </p>

      {library.loadFailed && !library.library ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="media-load-failed">
          Your uploaded images couldn&apos;t be loaded.
          <Button type="button" variant="link" size="sm" className="h-auto p-0 max-sm:min-h-11" onClick={library.refresh}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground" data-testid="media-empty">
          No {text.plural} uploaded yet.
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label={`Your uploaded ${text.plural}`}>
          {items.map((a) => {
            const selected = a.url === value;
            const name = a.originalName ?? `Uploaded ${text.noun}`;
            return (
              <li key={a.id} className="relative" data-testid="media-item" data-url={a.url}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`Use ${name}, ${a.width} × ${a.height} px`}
                  disabled={disabled}
                  onClick={() => onSelect(a.url, a)}
                  className="block aspect-square w-full overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-primary"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- same-origin uploaded media, already resized */}
                  <img src={a.url} alt="" loading="lazy" decoding="async" width={a.width} height={a.height} className="size-full object-cover" />
                </button>
                <DeleteImage
                  asset={a}
                  selectedHere={selectedInEditor.includes(a.url)}
                  disabled={disabled || deleting}
                  onDelete={() => remove(a)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
