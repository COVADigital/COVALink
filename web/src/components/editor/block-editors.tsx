"use client";

import { ArrowDown, ArrowUp, Plus, Trash } from "lucide-react";
import type { ComponentProps, ComponentType } from "react";
import { FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { IMAGE_ALT_MAX, MAX_SOCIAL_ITEMS, type EditableBlockType } from "@/features/blocks/definitions";
import { getSocialPlatform, SOCIAL_PLATFORMS } from "@/features/blocks/social-platforms";
import { isMediaUrl } from "@/lib/validation/media";
import { rowLabel, SPACER_SIZES, type EditableItem } from "./block-items";
import { MediaPicker, type MediaLibraryState } from "./media-picker";

/**
 * Field editors for the editable block types (editors are client-only
 * and keyed by the same `type` as definitions and renderers). Each receives
 * raw string values; validation messages come from the shared input schemas.
 * Field ids are `blk-{blockId}-{field}`, which the list uses to move focus;
 * a social row's fields are `items.{index}.platform` / `items.{index}.url`.
 */
export interface BlockEditorProps {
  item: EditableItem;
  /** Messages to show now, by field (already filtered for touched/submitted). */
  errors: Record<string, string | undefined>;
  onChange: (field: string, value: string) => void;
  onBlur: (field: string) => void;
  /** Social rows: add, remove, move with the buttons, and edit a row's field. */
  socialRows: {
    add: () => void;
    remove: (index: number) => void;
    move: (from: number, to: number, via: "up" | "down") => void;
    change: (index: number, field: "platform" | "url", value: string) => void;
  };
  /** The owner's image library (for image blocks); null when it isn't available. */
  media: { library: MediaLibraryState; selectedInEditor: readonly string[] } | null;
}

export const blockFieldId = (blockId: string, field: string) => `blk-${blockId}-${field}`;

/** Ids of a social row's controls (focus targets after a move or removal). */
export const rowControlId = (blockId: string, index: number, control: "up" | "down" | "remove") =>
  `${blockFieldId(blockId, `items.${index}`)}-${control}`;

/** 44 px tall below `sm`, the compact size above (every editor control is a 44 px target on phones). */
export const TOUCH_TARGET = "max-sm:min-h-11";
export const TOUCH_ICON = "max-sm:size-11";

/** The field focused when a block is added. */
export const FIRST_FIELD: Record<EditableBlockType, string> = {
  link: "title",
  heading: "text",
  text: "markdown",
  divider: "style",
  social: "items.0.platform",
  email: "label",
  phone: "label",
  contact: "firstName",
  spacer: "size",
  image: "src",
  video: "url",
  music: "url",
};

function TextArea({
  item,
  field,
  label,
  hint,
  rows,
  errors,
  onChange,
  onBlur,
}: BlockEditorProps & { field: string; label: string; hint?: string; rows: number }) {
  const id = blockFieldId(item.id, field);
  const error = errors[field];
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        rows={rows}
        value={item.values[field] ?? ""}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(field, e.target.value)}
        onBlur={() => onBlur(field)}
      />
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

function Choice({
  item,
  field,
  label,
  options,
  onChange,
}: Pick<BlockEditorProps, "item" | "onChange"> & { field: string; label: string; options: [value: string, label: string][] }) {
  const id = blockFieldId(item.id, field);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={item.values[field]}
        onChange={(e) => onChange(field, e.target.value)}
        className="h-11 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-10 dark:bg-input/30"
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

const ALIGN_OPTIONS: [string, string][] = [
  ["inherit", "Theme default"],
  ["left", "Left"],
  ["center", "Center"],
];

function LinkEditor(props: BlockEditorProps) {
  const { item, errors, onChange, onBlur } = props;
  return (
    <>
      <FormField
        id={blockFieldId(item.id, "title")}
        label="Title"
        value={item.values.title ?? ""}
        error={errors.title}
        onChange={(e) => onChange("title", e.target.value)}
        onBlur={() => onBlur("title")}
      />
      <FormField
        id={blockFieldId(item.id, "url")}
        label="Web address"
        type="url"
        inputMode="url"
        placeholder="example.com"
        hint="http:// or https://. Without a scheme, https:// is added."
        value={item.values.url ?? ""}
        error={errors.url}
        onChange={(e) => onChange("url", e.target.value)}
        onBlur={() => onBlur("url")}
      />
      <TextArea {...props} field="description" label="Description (optional)" rows={2} />
    </>
  );
}

function HeadingEditor(props: BlockEditorProps) {
  const { item, errors, onChange, onBlur } = props;
  return (
    <>
      <FormField
        id={blockFieldId(item.id, "text")}
        label="Heading text"
        value={item.values.text ?? ""}
        error={errors.text}
        onChange={(e) => onChange("text", e.target.value)}
        onBlur={() => onBlur("text")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice item={item} field="size" label="Size" options={[["sm", "Small"], ["md", "Medium"], ["lg", "Large"]]} onChange={onChange} />
        <Choice item={item} field="align" label="Alignment" options={ALIGN_OPTIONS} onChange={onChange} />
      </div>
    </>
  );
}

function TextEditor(props: BlockEditorProps) {
  return (
    <>
      <TextArea
        {...props}
        field="markdown"
        label="Text"
        hint="Use **bold**, *italic* and [link text](https://example.com). Leave a blank line between paragraphs."
        rows={5}
      />
      <Choice item={props.item} field="align" label="Alignment" options={ALIGN_OPTIONS} onChange={props.onChange} />
    </>
  );
}

function DividerEditor({ item, onChange }: BlockEditorProps) {
  return <Choice item={item} field="style" label="Style" options={[["line", "Line"], ["dots", "Dots"], ["fade", "Fade"]]} onChange={onChange} />;
}

/** A single-line text field bound to `item.values[field]`. */
function Text({
  item,
  errors,
  onChange,
  onBlur,
  field,
  label,
  type,
  inputMode,
  autoComplete,
  placeholder,
  hint,
}: BlockEditorProps & { field: string; label: string } & Pick<
    ComponentProps<typeof FormField>,
    "type" | "inputMode" | "autoComplete" | "placeholder" | "hint"
  >) {
  return (
    <FormField
      id={blockFieldId(item.id, field)}
      label={label}
      type={type}
      inputMode={inputMode}
      autoComplete={autoComplete}
      placeholder={placeholder}
      hint={hint}
      value={item.values[field] ?? ""}
      error={errors[field]}
      onChange={(e) => onChange(field, e.target.value)}
      onBlur={() => onBlur(field)}
    />
  );
}

const STYLE_OPTIONS: [string, string][] = [
  ["inherit", "Theme default"],
  ["icon", "Icons"],
  ["pill", "Icons with names"],
];
const PLATFORM_OPTIONS = SOCIAL_PLATFORMS.map((p) => [p.id, p.label] as const);

/**
 * Social links. Rows are ordered with Move up / Move down (the list
 * moves focus and announces each move); nested drag-and-drop isn't offered.
 */
function SocialEditor({ item, errors, onChange, onBlur, socialRows: rows }: BlockEditorProps) {
  const list = item.rows ?? [];
  const listError = errors.items;
  const addId = blockFieldId(item.id, "items");
  return (
    <>
      <Choice item={item} field="style" label="Style" options={STYLE_OPTIONS} onChange={onChange} />
      <fieldset className="grid gap-3" aria-describedby={listError ? `${addId}-error` : undefined}>
        <legend className="mb-1 text-sm font-medium">Social links</legend>
        {list.length > 0 && (
          <ol className="grid gap-3" aria-label="Social links, in page order">
            {list.map((row, index) => {
              const name = `link ${index + 1} (${rowLabel(row)})`;
              const platformId = blockFieldId(item.id, `items.${index}.platform`);
              const urlField = `items.${index}.url`;
              const platform = getSocialPlatform(row.platform);
              return (
                <li key={row.key} className="grid gap-3 rounded-lg border p-3" data-testid="social-row">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      Link {index + 1} of {list.length}
                    </span>
                    <div className="flex gap-0.5">
                      <Button
                        id={rowControlId(item.id, index, "up")}
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={TOUCH_ICON}
                        aria-label={`Move ${name} up`}
                        disabled={index === 0}
                        onClick={() => rows.move(index, index - 1, "up")}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        id={rowControlId(item.id, index, "down")}
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={TOUCH_ICON}
                        aria-label={`Move ${name} down`}
                        disabled={index === list.length - 1}
                        onClick={() => rows.move(index, index + 1, "down")}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Button
                        id={rowControlId(item.id, index, "remove")}
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={TOUCH_ICON}
                        aria-label={`Remove ${name}`}
                        onClick={() => rows.remove(index)}
                      >
                        <Trash aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={platformId}>Platform</Label>
                    <select
                      id={platformId}
                      value={row.platform}
                      onChange={(e) => rows.change(index, "platform", e.target.value)}
                      className="h-11 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-10 dark:bg-input/30"
                    >
                      {PLATFORM_OPTIONS.map(([value, text]) => (
                        <option key={value} value={value}>
                          {text}
                        </option>
                      ))}
                    </select>
                  </div>
                  <FormField
                    id={blockFieldId(item.id, urlField)}
                    label="Profile address"
                    type="url"
                    inputMode="url"
                    placeholder={platform?.placeholder}
                    hint="Must start with https:// (added when you leave it out)."
                    value={row.url}
                    error={errors[urlField]}
                    onChange={(e) => rows.change(index, "url", e.target.value)}
                    onBlur={() => onBlur(urlField)}
                  />
                </li>
              );
            })}
          </ol>
        )}
        {listError && (
          <p id={`${addId}-error`} className="text-xs text-destructive">
            {listError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            id={addId}
            type="button"
            variant="outline"
            size="sm"
            className={TOUCH_TARGET}
            disabled={list.length >= MAX_SOCIAL_ITEMS}
            aria-invalid={listError ? true : undefined}
            onClick={rows.add}
          >
            <Plus aria-hidden="true" />
            Add social link
          </Button>
          <span className="text-xs text-muted-foreground">
            {list.length} of {MAX_SOCIAL_ITEMS}
          </span>
        </div>
      </fieldset>
    </>
  );
}

function EmailEditor(props: BlockEditorProps) {
  return (
    <>
      <Text {...props} field="label" label="Button label" />
      <Text {...props} field="email" label="Email address" type="email" inputMode="email" autoComplete="off" placeholder="you@example.com" />
      <Text {...props} field="subject" label="Subject (optional)" hint="Filled in when the visitor's email app opens. One line." />
    </>
  );
}

function PhoneEditor(props: BlockEditorProps) {
  return (
    <>
      <Text {...props} field="label" label="Button label" />
      <Text
        {...props}
        field="phone"
        label="Phone number"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        placeholder="+1 555 010 0100"
        hint="4 to 15 digits; spaces, ( ), . and - are fine. Start with + for an international number."
      />
    </>
  );
}

function ContactEditor(props: BlockEditorProps) {
  return (
    <>
      <Text {...props} field="label" label="Button label" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Text {...props} field="firstName" label="First name" autoComplete="off" />
        <Text {...props} field="lastName" label="Last name" autoComplete="off" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Text {...props} field="organization" label="Organization" autoComplete="off" />
        <Text {...props} field="jobTitle" label="Job title" autoComplete="off" />
      </div>
      <Text {...props} field="email" label="Email (optional)" type="email" inputMode="email" autoComplete="off" />
      <Text {...props} field="phone" label="Phone (optional)" type="tel" inputMode="tel" autoComplete="off" hint="4 to 15 digits; spaces, ( ), . and - are fine." />
      <Text {...props} field="website" label="Website (optional)" type="url" inputMode="url" placeholder="example.com" />
      <TextArea {...props} field="note" label="Note (optional)" rows={3} />
      <p className="text-xs text-muted-foreground">Visitors download these details as a contact card (.vcf). Add a name or an organization.</p>
    </>
  );
}

function SpacerEditor({ item, onChange }: BlockEditorProps) {
  return (
    <Choice
      item={item}
      field="size"
      label="Height"
      options={Object.entries(SPACER_SIZES).map(([value, text]) => [value, text[0].toUpperCase() + text.slice(1)])}
      onChange={onChange}
    />
  );
}

const ASPECT_OPTIONS: [string, string][] = [
  ["auto", "Original shape"],
  ["square", "Square (1:1)"],
  ["wide", "Wide (16:9)"],
  ["portrait", "Portrait (4:5)"],
];
const IMAGE_NOUNS = { noun: "image", plural: "images" };

/**
 * Uploaded image. Any image in the shared library can be chosen;
 * its reported size only feeds the preview. A decorative image has
 * no description and can't be a link: the fields stay visible and
 * their messages say what to change, so nothing typed is dropped silently.
 */
function ImageEditor(props: BlockEditorProps) {
  const { item, errors, onChange, onBlur, media } = props;
  const src = item.values.src ?? "";
  const decorative = item.values.decorative === "true";
  const decorativeId = blockFieldId(item.id, "decorative");
  return (
    <>
      {media ? (
        <MediaPicker
          kind="background"
          testId="image"
          nouns={IMAGE_NOUNS}
          id={blockFieldId(item.id, "src")}
          label="Image"
          value={isMediaUrl(src) ? src : undefined}
          onSelect={(url, asset) => {
            onChange("src", url);
            onChange("width", String(asset.width));
            onChange("height", String(asset.height));
            onBlur("src");
          }}
          library={media.library}
          selectedInEditor={media.selectedInEditor}
          disabled={false}
          error={errors.src}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Your uploaded images aren&apos;t available here. Reload the page to try again.</p>
      )}
      <div className="flex items-center gap-3">
        <Switch
          id={decorativeId}
          className="max-sm:after:-inset-y-[13px]"
          checked={decorative}
          aria-describedby={`${decorativeId}-hint`}
          onCheckedChange={(v) => onChange("decorative", String(v))}
        />
        <div className="grid gap-0.5">
          <Label htmlFor={decorativeId}>Decorative image</Label>
          <p id={`${decorativeId}-hint`} className="text-xs text-muted-foreground">
            Screen readers skip it. Use only when the image adds nothing to the page.
          </p>
        </div>
      </div>
      <Text
        {...props}
        field="alt"
        label={decorative ? "Description (leave empty)" : "Description (alt text)"}
        hint={`What the image shows, for people who can't see it. Up to ${IMAGE_ALT_MAX} characters, one line.`}
      />
      <Text {...props} field="caption" label="Caption (optional)" hint="Shown under the image. One line." />
      <Text
        {...props}
        field="href"
        label="Link (optional)"
        type="url"
        inputMode="url"
        placeholder="example.com"
        hint="Opens when the image is selected. Not available for decorative images."
      />
      <Choice item={item} field="aspect" label="Shape" options={ASPECT_OPTIONS} onChange={onChange} />
    </>
  );
}

/** A provider link and an optional title. The block's server-side rules decide what's accepted. */
const embedEditor = (hint: string, placeholder: string) =>
  function EmbedEditor(props: BlockEditorProps) {
    return (
      <>
        <Text {...props} field="url" label="Link" type="url" inputMode="url" placeholder={placeholder} hint={hint} />
        <Text {...props} field="title" label="Title (optional)" hint="Names the player for screen readers and on your page. One line." />
      </>
    );
  };

const VideoEditor = embedEditor(
  "A public YouTube or Vimeo link, starting with https://. Unlisted Vimeo links and playlists can't be used.",
  "https://www.youtube.com/watch?v=…",
);
const MusicEditor = embedEditor(
  "A Spotify track, album, playlist, artist, episode or show, or a public SoundCloud track or set, starting with https://. Short links can't be used.",
  "https://open.spotify.com/track/…",
);

export const BLOCK_EDITORS: Record<EditableBlockType, ComponentType<BlockEditorProps>> = {
  link: LinkEditor,
  heading: HeadingEditor,
  text: TextEditor,
  divider: DividerEditor,
  social: SocialEditor,
  email: EmailEditor,
  phone: PhoneEditor,
  contact: ContactEditor,
  spacer: SpacerEditor,
  image: ImageEditor,
  video: VideoEditor,
  music: MusicEditor,
};
