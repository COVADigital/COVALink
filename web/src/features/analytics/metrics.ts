/**
 * Metric definitions. Pure, so the dashboard and the tests compute
 * them the same way.
 *
 * - Views: accepted view events in the interval.
 * - Clicks: accepted click events in the interval (never deduplicated).
 * - CTR: clicks ÷ views over the same interval; undefined ("—") when there
 *   are no views. It can exceed 100% (clicks aren't deduplicated, and
 *   visitors without JavaScript can click without a view).
 * - Approximate visitors: for each UTC day, the number of distinct non-null
 *   visitor hashes among that day's views; summed over the days. A visitor
 *   seen on two days counts twice (salts rotate daily).
 */

export function clickThroughRate(clicks: number, views: number): number | null {
  return views === 0 ? null : clicks / views;
}

export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

/**
 * How trustworthy the visitor count is for a period:
 * - `none`: no views at all;
 * - `approximate`: every view had a visitor hash;
 * - `partial`: some views had no hash (no trusted client address), so the count is a lower bound;
 * - `unavailable`: no view had a hash; no visitor count can be given.
 */
export type VisitorAvailability = "none" | "approximate" | "partial" | "unavailable";

export function visitorAvailability(views: number, viewsWithoutHash: number): VisitorAvailability {
  if (views === 0) return "none";
  if (viewsWithoutHash === 0) return "approximate";
  return viewsWithoutHash >= views ? "unavailable" : "partial";
}

export interface DailyRow {
  day: string;
  views: number;
  clicks: number;
  visitors: number;
  viewsWithoutHash: number;
}

/** One row per day of `days` (zeros where nothing happened), in order. */
export function fillDaily(days: string[], rows: DailyRow[]): DailyRow[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => byDay.get(day) ?? { day, views: 0, clicks: 0, visitors: 0, viewsWithoutHash: 0 });
}

export interface Totals {
  views: number;
  clicks: number;
  ctr: number | null;
  visitors: number;
  viewsWithoutHash: number;
  visitorAvailability: VisitorAvailability;
}

export function totals(daily: DailyRow[]): Totals {
  const sum = (k: keyof Omit<DailyRow, "day">) => daily.reduce((n, r) => n + r[k], 0);
  const views = sum("views");
  const clicks = sum("clicks");
  const viewsWithoutHash = sum("viewsWithoutHash");
  return {
    views,
    clicks,
    ctr: clickThroughRate(clicks, views),
    visitors: sum("visitors"),
    viewsWithoutHash,
    visitorAvailability: visitorAvailability(views, viewsWithoutHash),
  };
}
