import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import {
  BreakdownTable,
  DailyTable,
  deviceRows,
  linkRows,
  RangePicker,
  referrerRows,
  sourceRows,
  StatCards,
} from "@/components/analytics/analytics-panels";
import { DailyChart } from "@/components/analytics/daily-chart";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { qrFileName, qrTargetUrl } from "@/features/analytics/qr";
import { getProfileAnalytics, type ProfileAnalytics } from "@/features/analytics/service";
import { requireUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const metadata: Metadata = { title: "Analytics", robots: { index: false, follow: false } };

export default function AnalyticsPage({ params, searchParams }: PageProps<"/dashboard/profiles/[id]/analytics">) {
  return (
    <Suspense fallback={<AnalyticsSkeleton />}>
      <Analytics params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * Owner-only analytics for one profile. Ownership is enforced by
 * `getProfileAnalytics` (owner-scoped query); any other id is a 404. Reads the
 * session per request behind Suspense; nothing here is cached.
 */
async function Analytics({ params, searchParams }: Pick<PageProps<"/dashboard/profiles/[id]/analytics">, "params" | "searchParams">) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  let data: ProfileAnalytics;
  try {
    data = await getProfileAnalytics(user.id, id, { range: one(sp.range), from: one(sp.from), to: one(sp.to) });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    logger.error({ err, userId: user.id }, "Loading analytics failed");
    return (
      <>
        <AppHeader user={user} />
        <main className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-8 sm:px-6">
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <div role="alert" className="grid gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm" data-testid="analytics-error">
            <p>Analytics couldn&apos;t be loaded right now. Your data is safe; try again in a moment.</p>
            <Button asChild size="sm" variant="outline" className="w-fit">
              <Link href={`/dashboard/profiles/${encodeURIComponent(id)}/analytics`}>Try again</Link>
            </Button>
          </div>
        </main>
      </>
    );
  }

  const { profile, range, totals } = data;
  const basePath = `/dashboard/profiles/${profile.id}/analytics`;
  const showVisitors = totals.visitorAvailability === "approximate" || totals.visitorAvailability === "partial";
  const qrUrl = qrTargetUrl(env().APP_URL, profile.handle);
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:px-6">
        <div className="grid gap-1">
          <Link href={`/dashboard/profiles/${profile.id}`} className="w-fit text-sm text-muted-foreground underline-offset-4 hover:underline">
            ← Edit {profile.label}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            /{profile.handle}
            {!profile.isPublished && " · not published: no new views or clicks are recorded"}
          </p>
        </div>

        <RangePicker basePath={basePath} range={range} error={data.rangeError} retentionDays={data.retentionDays} />

        {totals.views === 0 && totals.clicks === 0 && (
          <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground" data-testid="analytics-empty">
            No views or clicks in this period yet. Views are counted when a visitor&apos;s browser loads your published page with
            JavaScript; your own visits while signed in aren&apos;t counted.
          </p>
        )}

        <StatCards totals={totals} />

        <section aria-labelledby="daily-heading" className="grid gap-3 rounded-xl border bg-card p-4">
          <h2 id="daily-heading" className="text-sm font-medium">
            Views and clicks by day
          </h2>
          <DailyChart id="daily" daily={data.daily} />
          <DailyTable daily={data.daily} showVisitors={showVisitors} />
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          <BreakdownTable
            id="links"
            title="Top links"
            description="Clicks per link block. Names are from the current published page."
            rows={linkRows(data.topLinks)}
            unit="Clicks"
            empty="No link clicks in this period."
          />
          <BreakdownTable
            id="referrers"
            title="Referring sites"
            description="The website a view came from (host name only)."
            rows={referrerRows(data.referrers)}
            unit="Views"
            empty="No views in this period."
          />
          <BreakdownTable id="devices" title="Devices" description="Device type of each view." rows={deviceRows(data.devices)} unit="Views" empty="No views in this period." />
          <BreakdownTable
            id="sources"
            title="Sources"
            description="Views from your QR code, and everything else."
            rows={sourceRows(data.sources)}
            unit="Views"
            empty="No views in this period."
          />
        </div>

        <section aria-labelledby="qr-heading" className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[auto_1fr] sm:items-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- same-origin generated SVG */}
          <img src={`/dashboard/profiles/${profile.id}/qr`} alt="" width={128} height={128} className="size-32 rounded-md border bg-white" />
          <div className="grid gap-2">
            <h2 id="qr-heading" className="text-sm font-medium">
              QR code
            </h2>
            <p className="break-all text-sm text-muted-foreground">
              Opens <span data-testid="qr-target">{qrUrl}</span>. Visits from it appear as &ldquo;QR code&rdquo; under Sources.
            </p>
            <p className="text-xs text-muted-foreground">
              The code contains your handle: if you change the handle, download and print a new one.
            </p>
            <Button asChild size="sm" className="w-fit">
              <a href={`/dashboard/profiles/${profile.id}/qr`} download={qrFileName(profile.handle)} data-testid="qr-download">
                Download QR code (SVG)
              </a>
            </Button>
          </div>
        </section>

        <p className="text-xs text-muted-foreground">
          Bots, link previews, prefetches, your own signed-in visits and repeat views within 30 minutes (when visitors can be told apart) aren&apos;t
          counted. Visitors without JavaScript aren&apos;t counted as views. No cookies, IP addresses or browser details are stored.
        </p>
      </main>
    </>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-8 sm:px-6" aria-busy="true" aria-label="Loading analytics" data-testid="analytics-loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
