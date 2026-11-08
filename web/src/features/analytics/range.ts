/**
 * Dashboard date ranges. All days are UTC calendar days written
 * `YYYY-MM-DD`. A range covers `from` through `to` inclusive, queried as the
 * half-open instant interval [from 00:00Z, (to + 1 day) 00:00Z).
 *
 * - Preset N (7, 30, 90): today and the N − 1 days before it, capped at the
 *   retention period.
 * - Custom: explicit `from`/`to`, not in the future, at most
 *   min(retentionDays, MAX_RANGE_DAYS) days long, and starting no earlier
 *   than the oldest retained day (today − (retentionDays − 1)).
 */

export const PRESET_DAYS = [7, 30, 90] as const;
export type PresetDays = (typeof PRESET_DAYS)[number];
export const DEFAULT_PRESET: PresetDays = 30;
/** Longest range one dashboard view renders (daily table and chart size). */
export const MAX_RANGE_DAYS = 400;

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AnalyticsRange {
  from: string;
  to: string;
  days: number;
  /** Inclusive start instant. */
  start: Date;
  /** Exclusive end instant. */
  end: Date;
  preset: PresetDays | null;
  /** True when the retention period shortened the requested range. */
  capped: boolean;
}

export type RangeResult = { ok: true; range: AnalyticsRange } | { ok: false; error: string; range: AnalyticsRange };

export interface RangeInput {
  range?: string;
  from?: string;
  to?: string;
}

/** Parses a strict UTC calendar date; `2026-02-30` and other non-dates are refused. */
export function parseDay(value: string | undefined): Date | null {
  if (!value || !DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || formatDay(d) !== value ? null : d;
}

export const formatDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
export const utcToday = (now: Date) => parseDay(formatDay(now))!;

function build(fromDay: Date, toDay: Date, preset: PresetDays | null, capped: boolean): AnalyticsRange {
  return {
    from: formatDay(fromDay),
    to: formatDay(toDay),
    days: Math.round((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1,
    start: fromDay,
    end: addDays(toDay, 1),
    preset,
    capped,
  };
}

export function presetRange(preset: PresetDays, { now, retentionDays }: { now: Date; retentionDays: number }): AnalyticsRange {
  const today = utcToday(now);
  const days = Math.min(preset, retentionDays, MAX_RANGE_DAYS);
  return build(addDays(today, -(days - 1)), today, preset, days < preset);
}

export function resolveRange(input: RangeInput, ctx: { now: Date; retentionDays: number }): RangeResult {
  const fallback = presetRange(DEFAULT_PRESET, ctx);
  if (input.from === undefined && input.to === undefined) {
    if (input.range === undefined) return { ok: true, range: fallback };
    const n = Number(input.range);
    const preset = PRESET_DAYS.find((p) => String(p) === input.range && p === n);
    return preset ? { ok: true, range: presetRange(preset, ctx) } : { ok: false, error: "Choose 7, 30 or 90 days, or enter dates.", range: fallback };
  }
  const from = parseDay(input.from);
  const to = parseDay(input.to);
  if (!from || !to) return { ok: false, error: "Enter both dates as YYYY-MM-DD.", range: fallback };
  const today = utcToday(ctx.now);
  const oldest = addDays(today, -(ctx.retentionDays - 1));
  const maxDays = Math.min(ctx.retentionDays, MAX_RANGE_DAYS);
  if (from > to) return { ok: false, error: "The start date must be on or before the end date.", range: fallback };
  if (to > today) return { ok: false, error: "The end date can't be in the future (dates are UTC).", range: fallback };
  if (from < oldest) {
    return { ok: false, error: `Analytics are kept for ${ctx.retentionDays} days; the earliest available day is ${formatDay(oldest)}.`, range: fallback };
  }
  const range = build(from, to, null, false);
  if (range.days > maxDays) return { ok: false, error: `Choose at most ${maxDays} days.`, range: fallback };
  return { ok: true, range };
}

/** Every day of the range, in order. */
export function rangeDays(range: AnalyticsRange): string[] {
  return Array.from({ length: range.days }, (_, i) => formatDay(addDays(range.start, i)));
}
