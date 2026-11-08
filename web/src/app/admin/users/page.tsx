import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AdminError, AdminFrame, AdminSkeleton, DESTRUCTIVE_OUTLINE, PageTitle, TOUCH } from "@/components/admin/admin-frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS } from "@/features/admin/audit-format";
import { listUsers, type UserListPage, type UserListQuery } from "@/features/admin/users";
import { requireCapability } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const metadata: Metadata = { title: "Users · Administration", robots: { index: false, follow: false } };

export default function AdminUsersPage({ searchParams }: PageProps<"/admin/users">) {
  return (
    <Suspense fallback={<AdminSkeleton label="Loading users" />}>
      <Users searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const dateUtc = (d: Date) => d.toISOString().slice(0, 10);

function href(query: UserListQuery, page: number) {
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  if (query.role !== "all") p.set("role", query.role);
  if (query.status !== "all") p.set("status", query.status);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return `/admin/users${s ? `?${s}` : ""}`;
}

/** User directory (`users.view`): server-side search, filters and pagination; authorization is in `listUsers`. */
async function Users({ searchParams }: Pick<PageProps<"/admin/users">, "searchParams">) {
  const user = await requireCapability("users.view");
  const sp = await searchParams;
  const input = Object.fromEntries(
    (["q", "role", "status", "page"] as const).flatMap((k) => (one(sp[k]) !== undefined ? [[k, one(sp[k])]] : [])),
  );
  let data: UserListPage | null = null;
  let invalid = false;
  try {
    data = await listUsers(user.id, input);
  } catch (err) {
    if (err instanceof AppError && err.code === "VALIDATION") invalid = true;
    else logger.error({ err, userId: user.id }, "Loading users failed");
  }
  return (
    <AdminFrame user={user} section="users">
      <PageTitle title="Users" description="Accounts on this installation, newest first." />
      <form method="get" action="/admin/users" role="search" aria-label="Find users" className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <label className="grid gap-1 text-sm">
          <span>Name or email</span>
          <input
            name="q"
            type="search"
            maxLength={100}
            defaultValue={data?.query.q ?? one(sp.q) ?? ""}
            className="h-11 rounded-md border bg-background px-3 text-sm sm:h-9"
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Role</span>
          <select name="role" defaultValue={data?.query.role ?? "all"} className="h-11 rounded-md border bg-background px-2 text-sm sm:h-9">
            <option value="all">All roles</option>
            <option value="user">User</option>
            <option value="admin">Administrator</option>
            <option value="super_admin">Super administrator</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>Status</span>
          <select name="status" defaultValue={data?.query.status ?? "all"} className="h-11 rounded-md border bg-background px-2 text-sm sm:h-9">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <Button type="submit" className={TOUCH}>
          Search
        </Button>
      </form>

      {invalid && <AdminError message="That search isn't valid. Use at most 100 characters." retryHref="/admin/users" />}
      {!data && !invalid && <AdminError message="Users couldn't be loaded right now." retryHref="/admin/users" />}
      {data && (
        <section aria-labelledby="results-heading" className="grid gap-3">
          <h2 id="results-heading" className="text-sm font-medium" aria-live="polite">
            {data.total === 1 ? "1 account" : `${data.total} accounts`}
            {data.pageCount > 1 && ` · page ${Math.min(data.query.page, data.pageCount)} of ${data.pageCount}`}
          </h2>
          {data.items.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground" data-testid="users-empty">
              No accounts match.{" "}
              <Link href="/admin/users" className="underline underline-offset-4">
                Clear the filters
              </Link>
            </p>
          ) : (
            <div role="region" aria-labelledby="results-heading" tabIndex={0} className="overflow-x-auto rounded-xl border bg-card focus-visible:outline-2 focus-visible:outline-ring">
              <table className="w-full min-w-160 text-sm" data-testid="users-table">
                <caption className="sr-only">Accounts</caption>
                <thead className="bg-muted text-left">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Name</th>
                    <th scope="col" className="px-3 py-2 font-medium">Email</th>
                    <th scope="col" className="px-3 py-2 font-medium">Role</th>
                    <th scope="col" className="px-3 py-2 font-medium">Status</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Profiles</th>
                    <th scope="col" className="px-3 py-2 font-medium">Created (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((u) => (
                    <tr key={u.id} className="border-t" data-testid="user-row">
                      <th scope="row" className="px-3 py-2 text-left font-normal">
                        <Link href={`/admin/users/${encodeURIComponent(u.id)}`} className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline sm:min-h-0">
                          {u.name}
                        </Link>
                      </th>
                      <td className="px-3 py-2 whitespace-nowrap">{u.email}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{ROLE_LABELS[u.role]}</td>
                      <td className="px-3 py-2">
                        <Badge variant={u.disabled ? "outline" : "secondary"} className={u.disabled ? DESTRUCTIVE_OUTLINE : undefined}>
                          {u.disabled ? "Disabled" : "Active"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.profileCount}</td>
                      <td className="px-3 py-2 tabular-nums">{dateUtc(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.pageCount > 1 && (
            <nav aria-label="Pages" className="flex flex-wrap items-center gap-2">
              {data.query.page > 1 && (
                <Button asChild variant="outline" className={TOUCH}>
                  <Link href={href(data.query, Math.min(data.query.page, data.pageCount + 1) - 1)}>Previous page</Link>
                </Button>
              )}
              {data.query.page < data.pageCount && (
                <Button asChild variant="outline" className={TOUCH}>
                  <Link href={href(data.query, data.query.page + 1)}>Next page</Link>
                </Button>
              )}
            </nav>
          )}
        </section>
      )}
    </AdminFrame>
  );
}
