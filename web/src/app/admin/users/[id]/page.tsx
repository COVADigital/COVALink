import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AdminError, AdminFrame, AdminSkeleton, DESTRUCTIVE_OUTLINE } from "@/components/admin/admin-frame";
import { UserActions } from "@/components/admin/user-actions";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS } from "@/features/admin/audit-format";
import { getUserDetail, type UserDetail } from "@/features/admin/users";
import { requireCapability } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const metadata: Metadata = { title: "Account · Administration", robots: { index: false, follow: false } };

export default function AdminUserPage({ params }: PageProps<"/admin/users/[id]">) {
  return (
    <Suspense fallback={<AdminSkeleton label="Loading account" />}>
      <Account params={params} />
    </Suspense>
  );
}

/** One account (`users.view`; actions per `canModerateUser` / `canChangeRole`, re-checked by the actions). */
async function Account({ params }: Pick<PageProps<"/admin/users/[id]">, "params">) {
  const user = await requireCapability("users.view");
  const { id } = await params;
  let detail: UserDetail | null = null;
  try {
    detail = await getUserDetail(user.id, id); // Next.js decodes the segment once
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    logger.error({ err, userId: user.id }, "Loading an account failed");
  }
  return (
    <AdminFrame user={user} section="users">
      <Link href="/admin/users" className="inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground underline-offset-4 hover:underline sm:min-h-0">
        ← All users
      </Link>
      {!detail ? (
        <AdminError message="This account couldn't be loaded right now." retryHref={`/admin/users/${encodeURIComponent(id)}`} />
      ) : (
        <>
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-tight wrap-break-word">{detail.name}</h1>
            <p className="text-sm break-all text-muted-foreground">{detail.email}</p>
          </div>
          <section aria-labelledby="account-heading" className="rounded-xl border bg-card p-5">
            <h2 id="account-heading" className="mb-4 text-sm font-medium">
              Account
            </h2>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">Role</dt>
              <dd data-testid="detail-role">{ROLE_LABELS[detail.role]}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Badge variant={detail.disabled ? "outline" : "secondary"} className={detail.disabled ? DESTRUCTIVE_OUTLINE : undefined} data-testid="detail-status">
                  {detail.disabled ? "Disabled" : "Active"}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd className="tabular-nums">{detail.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
              <dt className="text-muted-foreground">Account id</dt>
              <dd className="font-mono text-xs break-all">{detail.id}</dd>
            </dl>
          </section>
          <section aria-labelledby="profiles-heading" className="rounded-xl border bg-card p-5">
            <h2 id="profiles-heading" className="mb-3 text-sm font-medium">
              Profiles ({detail.profiles.length})
            </h2>
            {detail.profiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">This account has no profiles.</p>
            ) : (
              <ul className="grid gap-2 text-sm" data-testid="detail-profiles">
                {detail.profiles.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">/{p.handle}</span>
                    <span className="text-muted-foreground">{p.label}</span>
                    <Badge variant="outline">{p.isPublished ? (detail.disabled ? "Published (offline while disabled)" : "Published") : "Not published"}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <UserActions user={{ id: detail.id, name: detail.name, role: detail.role, disabled: detail.disabled }} allowed={detail.allowed} />
          <Link href={`/admin/audit?target=${encodeURIComponent(detail.id)}`} className="inline-flex min-h-11 w-fit items-center text-sm underline underline-offset-4 sm:min-h-0">
            Audit entries for this account
          </Link>
        </>
      )}
    </AdminFrame>
  );
}
