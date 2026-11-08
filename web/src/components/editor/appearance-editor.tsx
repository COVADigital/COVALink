"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MediaPicker, type MediaLibraryState } from "@/components/editor/media-picker";
import { themeContrastIssues, type ContrastIssue } from "@/features/themes/contrast";
import { FONT_STACKS, FONT_LABELS, themeToStyle } from "@/features/themes/css";
import { getPreset, THEME_PRESETS } from "@/features/themes/presets";
import {
  ALIGNS,
  AVATAR_SHAPES,
  AVATAR_SIZES,
  BUTTON_VARIANTS,
  FONT_IDS,
  MAX_OVERLAY,
  RADII,
  SCALES,
  SHADOWS,
  SPACINGS,
  WIDTHS,
  type PresetId,
  type ThemeConfig,
  type ThemeInput,
} from "@/features/themes/schema";
import { canonicalTheme, toThemeInput, type LockReason, type ThemeStatus } from "@/features/themes/theme";

/**
 * Appearance panel of the profile editor. The theme is edited as
 * the strict client input; the preview renders `canonicalTheme(input)` with
 * the same `themeToStyle` as the public page. A stored theme the editor can't
 * round-trip (`locked`) or read (`invalid`) is never edited field by field:
 * it can only be replaced, after confirmation, by a preset. An image
 * background uses one of the owner's uploaded background images.
 */

export interface AppearanceInfo {
  status: ThemeStatus;
  reasons: LockReason[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const HEX_MESSAGE = "Use a 6-digit hex color like #1a2b3c";

/** Theme field path (`section.key` or a top-level key) → DOM id. */
export const themeFieldId = (path: string) => `theme-${path.replace(".", "-")}`;

function setPath(t: ThemeInput, path: string, value: unknown): ThemeInput {
  const [section, key] = path.split(".");
  const obj = t as unknown as Record<string, unknown>;
  if (!key) return { ...obj, [section]: value } as unknown as ThemeInput;
  return { ...obj, [section]: { ...(obj[section] as Record<string, unknown>), [key]: value } } as unknown as ThemeInput;
}

const serialize = (t: ThemeInput | null) => JSON.stringify(t);

const DEFAULT_OVERLAY = 0.6;

/** A background of another type, keeping the colors; image fields exist only on image backgrounds. */
function switchBackground(
  bg: ThemeInput["background"],
  type: ThemeInput["background"]["type"],
  last: { imageUrl?: string; overlayOpacity: number },
): ThemeInput["background"] {
  const base = { color: bg.color, gradientTo: bg.gradientTo, gradientAngle: bg.gradientAngle };
  if (type !== "image") return { type, ...base };
  const imageUrl = bg.imageUrl ?? last.imageUrl;
  return { type, ...base, ...(imageUrl ? { imageUrl } : {}), overlayOpacity: bg.overlayOpacity ?? last.overlayOpacity };
}

export function useAppearance(initialTheme: ThemeConfig, initialInfo: AppearanceInfo) {
  const editable = (info: AppearanceInfo) => info.status === "editable";
  const [info, setInfo] = useState(initialInfo);
  // Parsed stored theme, shown in the preview while it isn't editable.
  const [stored, setStored] = useState(initialTheme);
  const [theme, setTheme] = useState<ThemeInput | null>(editable(initialInfo) ? toThemeInput(initialTheme) : null);
  const [saved, setSaved] = useState(() => serialize(editable(initialInfo) ? toThemeInput(initialTheme) : null));
  const [serverErrors, setServerErrors] = useState<Record<string, string[]>>({});
  // Color fields whose text isn't a valid hex yet; saving waits for them.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // The last chosen background image and overlay, restored when switching back to an image background.
  const [lastImage, setLastImage] = useState<{ imageUrl?: string; overlayOpacity: number }>(() => {
    const bg = initialTheme.background;
    return bg.type === "image" ? { imageUrl: bg.imageUrl, overlayOpacity: bg.overlayOpacity } : { overlayOpacity: DEFAULT_OVERLAY };
  });

  const previewTheme = useMemo(() => (theme ? canonicalTheme(theme) : stored), [theme, stored]);
  const issues = useMemo(() => themeContrastIssues(previewTheme), [previewTheme]);
  // An image background without a chosen image can't be saved yet.
  const missingImage = theme?.background.type === "image" && !theme.background.imageUrl;
  const blocking = useMemo(() => (missingImage ? new Set([...pending, "background.imageUrl"]) : pending), [pending, missingImage]);

  // Field to focus once it is rendered and visible: the editor switches to the Appearance tab
  // first, and that switch may commit only at the end of an async transition.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    const el = id ? document.getElementById(id) : null;
    // Visible and enabled: the panel's fieldset is disabled while a request is in flight.
    if (el && el.offsetParent !== null && !el.matches(":disabled")) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  return {
    info,
    theme,
    previewTheme,
    issues,
    serverErrors,
    /** Fields that must be fixed before saving (unfinished colors, a missing background image). */
    pending: blocking,
    missingImage,
    dirty: theme !== null && serialize(theme) !== saved,
    /** Replaces everything with a stored theme as the server returned it. */
    load(next: ThemeConfig, nextInfo: AppearanceInfo) {
      const input = editable(nextInfo) ? toThemeInput(next) : null;
      setInfo(nextInfo);
      setStored(next);
      setTheme(input);
      setSaved(serialize(input));
      setServerErrors({});
      setPending(new Set());
      if (next.background.type === "image") setLastImage({ imageUrl: next.background.imageUrl, overlayOpacity: next.background.overlayOpacity });
      pendingFocus.current = null;
    },
    update(path: string, value: unknown) {
      if (path === "background.type") {
        setTheme((t) => (t ? { ...t, background: switchBackground(t.background, value as ThemeInput["background"]["type"], lastImage) } : t));
      } else {
        setTheme((t) => (t ? setPath(t, path, value) : t));
      }
      if (path === "background.imageUrl") setLastImage((l) => ({ ...l, imageUrl: value as string }));
      if (path === "background.overlayOpacity") setLastImage((l) => ({ ...l, overlayOpacity: value as number }));
      // The gradient fields disappear with a solid background; their unfinished text no longer matters.
      if (path === "background.type" && value === "solid") {
        setPending((p) => new Set([...p].filter((k) => k !== "background.gradientTo" && k !== "background.gradientAngle")));
      }
      setServerErrors((e) => {
        if (!e[`theme.${path}`]) return e;
        const rest = { ...e };
        delete rest[`theme.${path}`];
        return rest;
      });
    },
    setPending(path: string, isPending: boolean) {
      setPending((p) => {
        if (p.has(path) === isPending) return p;
        const n = new Set(p);
        if (isPending) n.add(path);
        else n.delete(path);
        return n;
      });
    },
    applyPreset(id: PresetId) {
      const bg = theme?.background;
      if (bg?.type === "image") setLastImage({ imageUrl: bg.imageUrl, overlayOpacity: bg.overlayOpacity ?? DEFAULT_OVERLAY });
      setTheme(getPreset(id).theme);
      setServerErrors({});
      setPending(new Set());
    },
    /** Focuses a field (by theme path) as soon as it is visible. */
    focusField(path: string) {
      pendingFocus.current = themeFieldId(path);
    },
    applyServerErrors(fieldErrors: Record<string, string[]>) {
      setServerErrors(Object.fromEntries(Object.entries(fieldErrors).filter(([k]) => k.startsWith("theme."))));
    },
    /** The changed theme to send, or undefined to keep the stored one exactly. */
    toInput(): ThemeInput | undefined {
      return theme !== null && serialize(theme) !== saved ? theme : undefined;
    },
  };
}

export type AppearanceList = ReturnType<typeof useAppearance>;

const SELECT_CLASS =
  "h-10 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30";

function describedBy(...ids: (string | false | undefined)[]) {
  return ids.filter(Boolean).join(" ") || undefined;
}

function Messages({ id, error, warning, hint }: { id: string; error?: string; warning?: string; hint?: string }) {
  return (
    <>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
      {warning && (
        <p id={`${id}-contrast`} className="text-xs text-amber-700 dark:text-amber-400" data-testid="contrast-warning">
          {warning}
        </p>
      )}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </>
  );
}

function ColorField({
  path,
  label,
  value,
  error,
  warning,
  onChange,
  onPending,
}: {
  path: string;
  label: string;
  value: string;
  error?: string;
  warning?: string;
  onChange: (v: string) => void;
  onPending: (pending: boolean) => void;
}) {
  const id = themeFieldId(path);
  // Typed text, kept until it is a valid color; re-synced when the value changes elsewhere (a preset).
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setText(value);
  }
  const hexError = HEX.test(text) ? undefined : HEX_MESSAGE;
  const shown = hexError ?? error;
  function edit(next: string) {
    setText(next);
    const ok = HEX.test(next);
    onPending(!ok);
    if (ok) {
      const lower = next.toLowerCase();
      setSynced(lower);
      onChange(lower);
    }
  }
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={HEX.test(text) ? text.toLowerCase() : value}
          onChange={(e) => edit(e.target.value)}
          className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-1"
          data-testid={`${id}-picker`}
        />
        <Input
          id={id}
          value={text}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          className="h-10 font-mono"
          aria-invalid={shown ? true : undefined}
          aria-describedby={describedBy(shown && `${id}-error`, warning && `${id}-contrast`)}
          onChange={(e) => edit(e.target.value.trim())}
        />
      </div>
      <Messages id={id} error={shown} warning={warning} />
    </div>
  );
}

function SelectField<T extends string | number>({
  path,
  label,
  value,
  options,
  error,
  onChange,
}: {
  path: string;
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  error?: string;
  onChange: (v: T) => void;
}) {
  const id = themeFieldId(path);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={String(value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(error && `${id}-error`)}
        onChange={(e) => {
          const picked = options.find(([v]) => String(v) === e.target.value);
          if (picked) onChange(picked[0]);
        }}
        className={SELECT_CLASS}
      >
        {options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>
            {text}
          </option>
        ))}
      </select>
      <Messages id={id} error={error} />
    </div>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      {children}
    </fieldset>
  );
}

const opts = <T extends string>(values: readonly T[], labels: Record<T, string>) => values.map((v) => [v, labels[v]] as const);

const BACKGROUND_LABELS = { solid: "Solid color", gradient: "Gradient", image: "Image" } as const;

const VARIANT_LABELS = { fill: "Filled", outline: "Outline", soft: "Soft", glass: "Frosted glass" } as const;
const RADIUS_LABELS = { none: "Square", sm: "Slightly rounded", md: "Rounded", lg: "Very rounded", full: "Pill" } as const;
const SHADOW_LABELS = { none: "None", soft: "Soft", hard: "Hard offset" } as const;
const SCALE_LABELS = { sm: "Small", md: "Medium", lg: "Large" } as const;
const WIDTH_LABELS = { narrow: "Narrow", normal: "Normal", wide: "Wide" } as const;
const SPACING_LABELS = { compact: "Compact", normal: "Normal", relaxed: "Relaxed" } as const;
const ALIGN_LABELS = { center: "Centered", left: "Left" } as const;
const SHAPE_LABELS = { circle: "Circle", rounded: "Rounded square", square: "Square" } as const;
const BORDER_OPTIONS = [0, 1, 2, 3].map((n) => [n, n === 0 ? "None" : `${n} px`] as const);
const FONT_OPTIONS = FONT_IDS.map((f) => [f, FONT_LABELS[f]] as const);

const LOCK_TEXT: Record<LockReason, string> = {
  preset: "it uses a preset this version of COVALink doesn't offer",
  image: "it uses a background image that isn't one of your uploads",
  fields: "it has settings this editor can't reproduce",
};

function PresetSwatch({ id }: { id: PresetId }) {
  const style = themeToStyle(canonicalTheme(getPreset(id).theme));
  return (
    <span className="pp-swatch" style={style} aria-hidden="true">
      <span className="pp-swatch-text" style={{ fontFamily: style["--pp-font-heading" as keyof typeof style] as string }}>
        Aa
      </span>
      <span className="pp-swatch-btn" />
    </span>
  );
}

/** Confirmed replacement of a stored theme the editor can't carry. */
function ReplaceAppearance({ disabled, onReplace }: { disabled: boolean; onReplace: (id: PresetId) => void }) {
  const [choice, setChoice] = useState<PresetId>("minimal");
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled}>
          Replace saved appearance
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace saved appearance?</AlertDialogTitle>
          <AlertDialogDescription>
            Your saved appearance is replaced completely by the preset you choose, and your draft is saved. Your content and
            settings stay as they are. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="replace-preset">Start from</Label>
          <select id="replace-preset" value={choice} onChange={(e) => setChoice(e.target.value as PresetId)} className={SELECT_CLASS}>
            {THEME_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={() => onReplace(choice)}>Replace appearance</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AppearanceEditor({
  list,
  disabled,
  canReplace,
  onReplace,
  media,
  selectedInEditor,
}: {
  list: AppearanceList;
  disabled: boolean;
  /** Replacement saves the draft, so it waits until other changes are saved or discarded. */
  canReplace: boolean;
  onReplace: (id: PresetId) => void;
  media: MediaLibraryState;
  /** Uploaded images chosen in the editor (avatar and background), protected from deletion. */
  selectedInEditor: readonly string[];
}) {
  const { theme, info } = list;

  if (!theme) {
    const why = info.status === "invalid" ? null : info.reasons.map((r) => LOCK_TEXT[r]).join(", and ");
    return (
      <div className="grid gap-3">
        <div role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" data-testid="appearance-locked">
          {info.status === "invalid" ? (
            <>
              Your saved appearance can&apos;t be read by this version of COVALink, so your page uses the default look and
              this profile can&apos;t be published until you replace it. Your content can still be edited and saved.
            </>
          ) : (
            <>
              Your saved appearance can&apos;t be edited here because {why}. It&apos;s kept exactly as it is, and your page
              keeps using it. To change it, replace it with a preset.
              {list.issues.length > 0 && " It also doesn't have enough contrast to publish, so replace it before publishing."}
            </>
          )}
        </div>
        <ReplaceAppearance disabled={disabled || !canReplace} onReplace={onReplace} />
        {!canReplace && <p className="text-xs text-muted-foreground">Save or discard your other changes first.</p>}
      </div>
    );
  }

  const warningFor = (field: string) => list.issues.find((i: ContrastIssue) => i.field === field)?.message;
  const errorFor = (path: string) => list.serverErrors[`theme.${path}`]?.[0];
  const color = (path: string, label: string, value: string) => (
    <ColorField
      key={path}
      path={path}
      label={label}
      value={value}
      error={errorFor(path)}
      warning={warningFor(path)}
      onChange={(v) => list.update(path, v)}
      onPending={(p) => list.setPending(path, p)}
    />
  );
  const preset = getPreset(theme.preset);
  const isPresetValue = JSON.stringify(theme) === JSON.stringify(preset.theme);

  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-5">
      {list.issues.length > 0 && (
        <div role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" data-testid="contrast-summary">
          {list.issues.length === 1 ? "One color doesn't" : `${list.issues.length} colors don't`} have enough contrast. You can
          save this draft, but it can&apos;t be published until the highlighted colors are fixed.
        </div>
      )}

      <fieldset className="grid gap-3" aria-describedby="theme-preset-hint">
        <legend className="mb-2 text-sm font-medium">Preset</legend>
        <p className="text-xs text-muted-foreground" id="theme-preset-hint">
          Choosing a preset replaces all appearance settings below.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {THEME_PRESETS.map((p) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm has-checked:border-primary has-checked:ring-2 has-checked:ring-primary/30 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
            >
              <input
                type="radio"
                name="theme-preset"
                value={p.id}
                checked={theme.preset === p.id}
                onChange={() => list.applyPreset(p.id)}
                className="sr-only"
                data-testid={`preset-${p.id}`}
              />
              <PresetSwatch id={p.id} />
              <span className="min-w-0 truncate">{p.name}</span>
            </label>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          disabled={isPresetValue}
          onClick={() => list.applyPreset(theme.preset)}
        >
          Reset to {preset.name}
        </Button>
      </fieldset>

      <Group legend="Background">
        <fieldset className="grid gap-2 sm:col-span-2">
          <legend className="mb-1 text-sm">Type</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {(["solid", "gradient", "image"] as const).map((t) => (
              <label key={t} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="theme-background-type"
                  value={t}
                  checked={theme.background.type === t}
                  onChange={() => list.update("background.type", t)}
                  id={themeFieldId(`background.type-${t}`)}
                />
                {BACKGROUND_LABELS[t]}
              </label>
            ))}
          </div>
        </fieldset>
        {theme.background.type === "image" && (
          <div className="grid gap-4 sm:col-span-2">
            <MediaPicker
              kind="background"
              id={themeFieldId("background.imageUrl")}
              label="Background image"
              value={theme.background.imageUrl}
              onSelect={(url) => list.update("background.imageUrl", url)}
              library={media}
              selectedInEditor={selectedInEditor}
              disabled={disabled}
              error={errorFor("background.imageUrl") ?? (list.missingImage ? "Choose or upload a background image." : undefined)}
            />
            <OverlayField
              value={theme.background.overlayOpacity ?? 0}
              error={errorFor("background.overlayOpacity")}
              onChange={(v) => list.update("background.overlayOpacity", v)}
            />
          </div>
        )}
        {color(
          "background.color",
          theme.background.type === "gradient" ? "Start color" : theme.background.type === "image" ? "Fallback color" : "Background color",
          theme.background.color,
        )}
        {theme.background.type === "image" && (
          <p className="text-xs text-muted-foreground sm:col-span-2">
            The fallback color shows, under the same overlay, while the image loads. Over an image, text is checked against
            both the darkest and the brightest possible pixel, so a darker overlay and light text work best.
          </p>
        )}
        {theme.background.type === "gradient" && (
          <>
            {color("background.gradientTo", "End color", theme.background.gradientTo)}
            <AngleField
              value={theme.background.gradientAngle}
              error={errorFor("background.gradientAngle")}
              onChange={(v) => list.update("background.gradientAngle", v)}
              onPending={(p) => list.setPending("background.gradientAngle", p)}
            />
          </>
        )}
      </Group>

      <Group legend="Colors">
        {color("text.color", "Text", theme.text.color)}
        {color("text.muted", "Muted text", theme.text.muted)}
        {color("accent", "Accent", theme.accent)}
      </Group>

      <Group legend="Link buttons">
        <SelectField path="button.variant" label="Style" value={theme.button.variant} options={opts(BUTTON_VARIANTS, VARIANT_LABELS)} error={errorFor("button.variant")} onChange={(v) => list.update("button.variant", v)} />
        {color("button.color", "Button color", theme.button.color)}
        {color("button.textColor", "Button text", theme.button.textColor)}
        <SelectField path="button.radius" label="Corners" value={theme.button.radius} options={opts(RADII, RADIUS_LABELS)} onChange={(v) => list.update("button.radius", v)} />
        <SelectField path="button.shadow" label="Shadow" value={theme.button.shadow} options={opts(SHADOWS, SHADOW_LABELS)} onChange={(v) => list.update("button.shadow", v)} />
        <SelectField path="button.borderWidth" label="Border width" value={theme.button.borderWidth} options={BORDER_OPTIONS} onChange={(v) => list.update("button.borderWidth", v)} />
      </Group>

      <Group legend="Typography">
        <SelectField path="font.body" label="Body font" value={theme.font.body} options={FONT_OPTIONS} onChange={(v) => list.update("font.body", v)} />
        <SelectField path="font.heading" label="Heading font" value={theme.font.heading} options={FONT_OPTIONS} onChange={(v) => list.update("font.heading", v)} />
        <SelectField path="font.scale" label="Text size" value={theme.font.scale} options={opts(SCALES, SCALE_LABELS)} onChange={(v) => list.update("font.scale", v)} />
        <p className="text-xs text-muted-foreground sm:col-span-2" style={{ fontFamily: FONT_STACKS[theme.font.heading] }}>
          {FONT_LABELS[theme.font.heading]} headings, {FONT_LABELS[theme.font.body]} text.
        </p>
      </Group>

      <Group legend="Layout">
        <SelectField path="layout.width" label="Width" value={theme.layout.width} options={opts(WIDTHS, WIDTH_LABELS)} onChange={(v) => list.update("layout.width", v)} />
        <SelectField path="layout.spacing" label="Spacing" value={theme.layout.spacing} options={opts(SPACINGS, SPACING_LABELS)} onChange={(v) => list.update("layout.spacing", v)} />
        <SelectField path="layout.align" label="Alignment" value={theme.layout.align} options={opts(ALIGNS, ALIGN_LABELS)} onChange={(v) => list.update("layout.align", v)} />
      </Group>

      <Group legend="Avatar">
        <SelectField path="avatar.shape" label="Shape" value={theme.avatar.shape} options={opts(AVATAR_SHAPES, SHAPE_LABELS)} onChange={(v) => list.update("avatar.shape", v)} />
        <SelectField path="avatar.size" label="Size" value={theme.avatar.size} options={opts(AVATAR_SIZES, SCALE_LABELS)} onChange={(v) => list.update("avatar.size", v)} />
        <div className="flex items-center gap-3 sm:col-span-2">
          <Switch id={themeFieldId("avatar.ring")} checked={theme.avatar.ring} onCheckedChange={(v) => list.update("avatar.ring", v)} />
          <Label htmlFor={themeFieldId("avatar.ring")}>Accent ring around the avatar</Label>
        </div>
      </Group>
    </fieldset>
  );
}

function AngleField({
  value,
  error,
  onChange,
  onPending,
}: {
  value: number;
  error?: string;
  onChange: (v: number) => void;
  onPending: (pending: boolean) => void;
}) {
  const id = themeFieldId("background.gradientAngle");
  const [text, setText] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setText(String(value));
  }
  const n = Number(text);
  const valid = /^\d{1,3}$/.test(text) && n >= 0 && n <= 360;
  const shown = valid ? error : "Use 0 to 360 degrees";
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Angle (degrees)</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={360}
        step={1}
        value={text}
        className="h-10"
        aria-invalid={shown ? true : undefined}
        aria-describedby={describedBy(shown && `${id}-error`)}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          const ok = /^\d{1,3}$/.test(e.target.value) && v >= 0 && v <= 360;
          onPending(!ok);
          if (ok) {
            setSynced(v);
            onChange(v);
          }
        }}
      />
      <Messages id={id} error={shown} />
    </div>
  );
}

/** Black overlay over the background image, 0–90% in 5% steps. */
function OverlayField({ value, error, onChange }: { value: number; error?: string; onChange: (v: number) => void }) {
  const id = themeFieldId("background.overlayOpacity");
  const pct = Math.round(value * 100);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>Overlay darkness</Label>
        <output htmlFor={id} className="text-sm tabular-nums text-muted-foreground" data-testid="overlay-value">
          {pct}%
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={Math.round(MAX_OVERLAY * 100)}
        step={5}
        value={pct}
        aria-valuetext={`${pct}% black overlay`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(error && `${id}-error`)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="w-full accent-primary"
      />
      <Messages id={id} error={error} />
    </div>
  );
}
