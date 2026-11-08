import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AdminError, AdminFrame, AdminSkeleton, PageTitle, TOUCH } from "@/components/admin/admin-frame";
import { Button } from "@/components/ui/button";
import { AUDIT_ACTION_LABELS, AUDIT_ACTIONS } from "@/features/admin/audit-format";
import { listAuditEntries, type AuditPage, type AuditPerson, type AuditQuery } from "@/features/admin/audit";
import { requireCapability } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const metadata: Metadata = { title: "Audit log · Administration", robots: { index: false, follow: false } };

export default function AdminAuditPage({ searchParams }: PageProps<"/admin/audit">) {
  return (
    <Suspense fallback={<AdminSkeleton label="Loading audit log" />}>
      <Audit searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const KEYS = ["action", "actor", "target", "from", "to", "cursor"] as const;

function href(query: AuditQuery, cursor?: string) {
  const p = new URLSearchParams();
  if (query.action !== "all") p.set("action", query.action);
  for (const k of ["actor", "target", "from", "to"] as const) if (query[k]) p.set(k, query[k]!);
  if (cursor) p.set("cursor", cursor);
  const s = p.toString();
  return `/admin/audit${s ? `?${s}` : ""}`;
}

function Person({ person, fallback }: { person: AuditPerson | null; fallback: string }) {
  if (!person) return <span className="text-muted-foreground">{fallback}</span>;
  return (
    <span className="grid">
      <Link href={`/admin/users/${encodeURIComponent(person.id)}`} className="inline-flex min-h-11 items-center underline-offset-4 hover:underline sm:min-h-0">
        {person.name ?? "Deleted account"}
      </Link>
      {person.email && <span className="text-xs break-all text-muted-foreground">{person.email}</span>}
    </span>
  );
}

/** Audit log (`audit.view`): newest first, keyset pages, only allowlisted fields rendered. */
async function Audit({ searchParams }: Pick<PageProps<"/admin/audit">, "searchParams">) {
  const user = await requireCapability("audit.view");
  const sp = await searchParams;
  const input = Object.fromEntries(KEYS.flatMap((k) => (one(sp[k]) !== undefined ? [[k, one(sp[k])]] : [])));
  let data: AuditPage | null = null;
  let invalid: string | null = null;
  try {
    data = await listAuditEntries(user.id, input);
  } catch (err) {
    if (err instanceof AppError && err.code === "VALIDATION") invalid = err.message;
    else logger.error({ err, userId: user.id }, "Loading the audit log failed");
  }
  const q = data?.query;
  return (
    <AdminFrame user={user} section="audit">
      <PageTitle title="Audit log" description="Administrative and security changes, newest first. Entries are kept indefinitely." />
      <form method="get" action="/admin/audit" aria-label="Filter the audit log" className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_auto_auto_auto] lg:items-end">
        <label className="grid gap-1 text-sm">
          <span>Event</span>
          <select name="action" defaultValue={q?.action ?? "all"} className="h-11 rounded-md border bg-background px-2 text-sm sm:h-9">
            <option value="all">All events</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {AUDIT_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>By (account id)</span>
          <input name="actor" maxLength={64} defaultValue={q?.actor ?? one(sp.actor) ?? ""} className="h-11 rounded-md border bg-background px-3 font-mono text-xs sm:h-9" />
        </label>
        <label className="grid gap-1 text-sm">
          <span>About (account id)</span>
          <input name="target" maxLength={64} defaultValue={q?.target ?? one(sp.target) ?? ""} className="h-11 rounded-md border bg-background px-3 font-mono text-xs sm:h-9" />
        </label>
        <label className="grid gap-1 text-sm">
          <span>From (UTC)</span>
          <input type="date" name="from" defaultValue={q?.from ?? ""} className="h-11 rounded-md border bg-background px-2 text-sm sm:h-9" />
        </label>
        <label className="grid gap-1 text-sm">
          <span>To (UTC)</span>
          <input type="date" name="to" defaultValue={q?.to ?? ""} className="h-11 rounded-md border bg-background px-2 text-sm sm:h-9" />
        </label>
        <Button type="submit" className={TOUCH}>
          Filter
        </Button>
      </form>

      {invalid && <AdminError message={`${invalid}.`} retryHref="/admin/audit" />}
      {!data && !invalid && <AdminError message="The audit log couldn't be loaded right now." retryHref="/admin/audit" />}
      {data && (
        <section aria-labelledby="entries-heading" className="grid gap-3">
          <h2 id="entries-heading" className="text-sm font-medium">
            {data.query.cursor ? "Older entries" : "Latest entries"}
          </h2>
          {data.entries.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground" data-testid="audit-empty">
              No entries match.{" "}
              <Link href="/admin/audit" className="underline underline-offset-4">
                Show all entries
              </Link>
            </p>
          ) : (
            <div role="region" aria-labelledby="entries-heading" tabIndex={0} className="overflow-x-auto rounded-xl border bg-card focus-visible:outline-2 focus-visible:outline-ring">
              <table className="w-full min-w-176 text-sm" data-testid="audit-table">
                <caption className="sr-only">Audit entries</caption>
                <thead className="bg-muted text-left">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">When (UTC)</th>
                    <th scope="col" className="px-3 py-2 font-medium">Event</th>
                    <th scope="col" className="px-3 py-2 font-medium">Change</th>
                    <th scope="col" className="px-3 py-2 font-medium">By</th>
                    <th scope="col" className="px-3 py-2 font-medium">About</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id} className="border-t align-top" data-testid="audit-row" data-action={e.action}>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        <time dateTime={e.at.toISOString()}>{e.at.toISOString().slice(0, 19).replace("T", " ")}</time>
                      </td>
                      <th scope="row" className="px-3 py-2 text-left font-medium">
                        {e.display.title}
                        {e.display.detail && <span className="block text-xs font-normal text-muted-foreground">{e.display.detail}</span>}
                      </th>
                      <td className="px-3 py-2">{e.display.change ? `${e.display.change.from} → ${e.display.change.to}` : "—"}</td>
                      <td className="px-3 py-2">
                        <Person person={e.actor} fallback="System" />
                      </td>
                      <td className="px-3 py-2">
                        <Person person={e.target} fallback={e.targetType === "setting" ? "Installation" : "—"} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav aria-label="Pages" className="flex flex-wrap gap-2">
            {data.query.cursor && (
              <Button asChild variant="outline" className={TOUCH}>
                <Link href={href(data.query)}>Newest entries</Link>
              </Button>
            )}
            {data.nextCursor && (
              <Button asChild variant="outline" className={TOUCH}>
                <Link href={href(data.query, data.nextCursor)}>Older entries</Link>
              </Button>
            )}
          </nav>
        </section>
      )}
    </AdminFrame>
  );
}
