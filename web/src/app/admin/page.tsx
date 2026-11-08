import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminError, AdminFrame, AdminSkeleton, PageTitle } from "@/components/admin/admin-frame";
import { statusRows } from "@/features/admin/status-format";
import { getInstallationSummary, getSystemStatus } from "@/features/admin/status";
import { requireCapability } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

export const metadata: Metadata = { title: "Administration", robots: { index: false, follow: false } };

export default function AdminPage() {
  return (
    <Suspense fallback={<AdminSkeleton label="Loading administration" />}>
      <Overview />
    </Suspense>
  );
}

/**
 * Overview and safe installation status (`admin.access`). Only the
 * fixed vocabulary of `statusRows` is rendered. A database outage can't be
 * shown here (signing in needs the database); `/api/ready` reports it.
 */
async function Overview() {
  const user = await requireCapability("admin.access");
  const [status, summary] = await Promise.all([
    getSystemStatus(user.id).catch((err) => {
      logger.error({ err, userId: user.id }, "Loading system status failed");
      return null;
    }),
    getInstallationSummary(user.id).catch(() => null),
  ]);
  return (
    <AdminFrame user={user} section="overview">
      <PageTitle title="Administration" description="Installation status. Details never include addresses, paths or credentials." />
      {summary && (
        <section aria-labelledby="installation-heading" className="rounded-xl border bg-card p-5">
          <h2 id="installation-heading" className="mb-4 text-sm font-medium">
            Installation
          </h2>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[14rem_1fr]">
            <dt className="text-muted-foreground">Accounts</dt>
            <dd data-testid="user-count">{summary.accounts}</dd>
            <dt className="text-muted-foreground">Set up</dt>
            <dd>{summary.setUpAt ? `${summary.setUpAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Not completed"}</dd>
          </dl>
        </section>
      )}
      {status ? (
        <section aria-labelledby="status-heading" className="rounded-xl border bg-card p-5">
          <h2 id="status-heading" className="mb-4 text-sm font-medium">
            System status
          </h2>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[14rem_1fr]" data-testid="system-status">
            {statusRows(status).map((row) => (
              <div key={row.id} className="contents">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd data-testid={`status-${row.id}`} data-tone={row.tone} className={row.tone === "warn" ? "font-medium text-destructive" : undefined}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            Database outages make this page unavailable (signing in needs the database). Monitor <code>/api/ready</code> for those.
          </p>
        </section>
      ) : (
        <AdminError message="The system status couldn't be loaded right now." retryHref="/admin" />
      )}
    </AdminFrame>
  );
}
