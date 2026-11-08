import type { DailyRow } from "@/features/analytics/metrics";

const WIDTH = 720;
const HEIGHT = 200;
const PAD = 8;

/**
 * Daily views (bars) and clicks (line with points), server-rendered SVG with
 * no chart library. The two series differ in shape, not only color.
 * The SVG is one labelled image with a text description; the same numbers
 * are in the table next to it (`DailyTable`), which is the accessible
 * equivalent.
 */
export function DailyChart({ id, daily }: { id: string; daily: DailyRow[] }) {
  const max = Math.max(1, ...daily.map((d) => Math.max(d.views, d.clicks)));
  const slot = (WIDTH - PAD * 2) / Math.max(1, daily.length);
  const barWidth = Math.max(1, slot * 0.7);
  const y = (v: number) => HEIGHT - PAD - (v / max) * (HEIGHT - PAD * 2);
  const cx = (i: number) => PAD + slot * i + slot / 2;
  const totalViews = daily.reduce((n, d) => n + d.views, 0);
  const totalClicks = daily.reduce((n, d) => n + d.clicks, 0);
  const peak = daily.reduce((best, d) => (d.views > best.views ? d : best), daily[0] ?? { day: "", views: 0 });
  const first = daily[0]?.day ?? "";
  const last = daily[daily.length - 1]?.day ?? "";
  const description =
    `${daily.length} days from ${first} to ${last} (UTC): ${totalViews} views and ${totalClicks} clicks in total` +
    (peak.views > 0 ? `; most views on ${peak.day} (${peak.views}).` : ".");
  const clickPoints = daily.map((d, i) => `${cx(i).toFixed(1)},${y(d.clicks).toFixed(1)}`).join(" ");

  return (
    <figure className="grid gap-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-48 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
        data-testid="daily-chart"
      >
        <title id={`${id}-title`}>Daily views and clicks</title>
        <desc id={`${id}-desc`}>{description}</desc>
        <line x1={PAD} x2={WIDTH - PAD} y1={HEIGHT - PAD} y2={HEIGHT - PAD} className="stroke-border" strokeWidth={1} />
        {daily.map((d, i) =>
          d.views > 0 ? (
            <rect
              key={d.day}
              x={cx(i) - barWidth / 2}
              y={y(d.views)}
              width={barWidth}
              height={HEIGHT - PAD - y(d.views)}
              className="fill-chart-2"
            />
          ) : null,
        )}
        {totalClicks > 0 && (
          <polyline points={clickPoints} fill="none" className="stroke-primary" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-sm bg-chart-2" /> Views (bars)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-4 bg-primary" /> Clicks (line)
        </span>
        <span>
          Scale: 0 to {max}. {first} to {last}, UTC.
        </span>
      </figcaption>
    </figure>
  );
}
