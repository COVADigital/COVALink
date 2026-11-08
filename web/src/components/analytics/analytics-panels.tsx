import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatRate, type DailyRow, type Totals, type VisitorAvailability } from "@/features/analytics/metrics";
import { PRESET_DAYS, type AnalyticsRange } from "@/features/analytics/range";
import type { BreakdownRow, LinkStat } from "@/features/analytics/service";

/** Server-rendered dashboard pieces for the analytics page. No client code. */

const number = new Intl.NumberFormat("en-US");

export function RangePicker({ basePath, range, error, retentionDays }: { basePath: string; range: AnalyticsRange; error: string | null; retentionDays: number }) {
  return (
    <section aria-labelledby="range-heading" className="grid gap-3 rounded-xl border bg-card p-4">
      <h2 id="range-heading" className="text-sm font-medium">
        Period
      </h2>
      <nav aria-label="Preset periods" className="flex flex-wrap gap-2">
        {PRESET_DAYS.map((days) => (
          <Button key={days} asChild size="sm" variant={range.preset === days ? "default" : "outline"}>
            <Link href={`${basePath}?range=${days}`} aria-current={range.preset === days ? "page" : undefined}>
              Last {days} days
            </Link>
          </Button>
        ))}
      </nav>
      <form method="get" action={basePath} className="flex flex-wrap items-end gap-3" aria-describedby="range-help">
        <label className="grid gap-1 text-sm">
          <span>From (UTC)</span>
          <input type="date" name="from" defaultValue={range.from} required className="h-9 rounded-md border bg-background px-2 text-sm" />
        </label>
        <label className="grid gap-1 text-sm">
          <span>To (UTC)</span>
          <input type="date" name="to" defaultValue={range.to} required className="h-9 rounded-md border bg-background px-2 text-sm" />
        </label>
        <Button type="submit" size="sm" variant="secondary">
          Show
        </Button>
      </form>
      <p id="range-help" className="text-xs text-muted-foreground">
        Days are UTC calendar days, both dates included. Analytics are kept for {retentionDays} days.
      </p>
      <p className="text-sm" data-testid="range-summary">
        Showing {range.from} to {range.to} ({range.days} {range.days === 1 ? "day" : "days"}).
        {range.capped && <> Shortened to the {retentionDays}-day retention period.</>}
      </p>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="range-error">
          {error} Showing the last {range.days} days instead.
        </p>
      )}
    </section>
  );
}

const VISITOR_NOTES: Record<VisitorAvailability, string> = {
  none: "No views in this period.",
  approximate: "Approximate: distinct visitors per UTC day, added up.",
  partial: "Partial: some views had no trusted visitor address, so this undercounts.",
  unavailable: "Unavailable: no trusted visitor addresses (TRUST_PROXY is off or unverified).",
};

export function StatCards({ totals }: { totals: Totals }) {
  const visitors = totals.visitorAvailability === "unavailable" ? "—" : number.format(totals.visitors);
  const items = [
    { label: "Views", value: number.format(totals.views), note: "Page views counted after filtering.", testId: "stat-views" },
    { label: "Clicks", value: number.format(totals.clicks), note: "Link clicks through COVALink.", testId: "stat-clicks" },
    { label: "Click-through rate", value: formatRate(totals.ctr), note: "Clicks ÷ views for the same period.", testId: "stat-ctr" },
    {
      label: totals.visitorAvailability === "partial" ? "Visitors (partial)" : "Visitors (approximate)",
      value: visitors,
      note: VISITOR_NOTES[totals.visitorAvailability],
      testId: "stat-visitors",
    },
  ];
  return (
    <section aria-labelledby="totals-heading">
      <h2 id="totals-heading" className="sr-only">
        Totals
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="grid content-start gap-1 rounded-xl border bg-card p-4">
            <dt className="text-sm text-muted-foreground">{item.label}</dt>
            <dd className="text-2xl font-semibold tabular-nums" data-testid={item.testId} data-availability={item.testId === "stat-visitors" ? totals.visitorAvailability : undefined}>
              {item.value}
            </dd>
            <dd className="text-xs text-muted-foreground">{item.note}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function DailyTable({ daily, showVisitors }: { daily: DailyRow[]; showVisitors: boolean }) {
  return (
    <div role="region" aria-labelledby="daily-table-caption" tabIndex={0} className="max-h-72 overflow-auto rounded-lg border focus-visible:outline-2 focus-visible:outline-ring">
      <table className="w-full text-sm" data-testid="daily-table">
        <caption id="daily-table-caption" className="sr-only">
          Views, clicks{showVisitors ? " and approximate visitors" : ""} per UTC day
        </caption>
        <thead className="sticky top-0 bg-muted text-left">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Day (UTC)</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Views</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Clicks</th>
            {showVisitors && <th scope="col" className="px-3 py-2 text-right font-medium">Visitors</th>}
          </tr>
        </thead>
        <tbody>
          {[...daily].reverse().map((d) => (
            <tr key={d.day} className="border-t">
              <th scope="row" className="px-3 py-1.5 text-left font-normal tabular-nums">{d.day}</th>
              <td className="px-3 py-1.5 text-right tabular-nums">{d.views}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{d.clicks}</td>
              {showVisitors && <td className="px-3 py-1.5 text-right tabular-nums">{d.visitors}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A ranked list as a semantic table; the bar in each row is decoration
 * (aria-hidden), so the table is the chart's accessible equivalent.
 */
export function BreakdownTable({
  id,
  title,
  description,
  rows,
  unit,
  empty,
}: {
  id: string;
  title: string;
  description: string;
  rows: { label: string; value: number; muted?: boolean }[];
  unit: string;
  empty: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section aria-labelledby={`${id}-heading`} className="grid content-start gap-2 rounded-xl border bg-card p-4">
      <h2 id={`${id}-heading`} className="text-sm font-medium">
        {title}
      </h2>
      <p className="text-xs text-muted-foreground">{description}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid={`${id}-empty`}>
          {empty}
        </p>
      ) : (
        <table className="w-full text-sm" data-testid={`${id}-table`}>
          <caption className="sr-only">{title}</caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-medium">Name</th>
              <th scope="col" className="w-20 py-1 text-right font-medium">{unit}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.label}-${i}`} className="border-t">
                <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                  <span className={r.muted ? "text-muted-foreground italic" : undefined}>{r.label}</span>
                  <span aria-hidden="true" className="mt-1 block h-1.5 rounded-full bg-chart-2" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
                </th>
                <td className="py-1.5 text-right align-top tabular-nums">{number.format(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export const linkRows = (links: LinkStat[]) =>
  links.map((l) => ({
    label: l.title === null ? "Deleted link" : l.hidden ? `${l.title} (hidden)` : l.title,
    value: l.clicks,
    muted: l.title === null,
  }));

const DEVICE_LABELS: Record<string, string> = { mobile: "Mobile", tablet: "Tablet", desktop: "Desktop", unknown: "Unknown" };

export const referrerRows = (rows: BreakdownRow[]) => rows.map((r) => ({ label: r.key ?? "Direct or unknown", value: r.views, muted: r.key === null }));
export const deviceRows = (rows: BreakdownRow[]) => rows.map((r) => ({ label: DEVICE_LABELS[r.key ?? "unknown"] ?? "Unknown", value: r.views }));
export const sourceRows = (rows: BreakdownRow[]) =>
  rows.map((r) => ({ label: r.key === "qr" ? "QR code" : r.key === null ? "No source (link or direct)" : r.key, value: r.views, muted: r.key === null }));
