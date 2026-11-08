import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminError, AdminFrame, AdminSkeleton, PageTitle } from "@/components/admin/admin-frame";
import { SettingForm } from "@/components/admin/setting-form";
import { SETTING_GROUPS, SETTING_SPECS } from "@/features/settings/catalog";
import { getAdminSettings, type AdminSetting } from "@/features/settings/service";
import { requireCapability } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

export const metadata: Metadata = { title: "Settings · Administration", robots: { index: false, follow: false } };

export default function AdminSettingsPage() {
  return (
    <Suspense fallback={<AdminSkeleton label="Loading settings" />}>
      <Settings />
    </Suspense>
  );
}

/**
 * Installation settings (`settings.manage` to read; security settings need
 * `settings.manageSecurity` to change). Every save goes through
 * `setSetting`, which checks the capability again and audits the change.
 * Email (SMTP) is configured by environment variables only.
 */
async function Settings() {
  const user = await requireCapability("settings.manage");
  let settings: AdminSetting[] | null = null;
  try {
    settings = await getAdminSettings(user.id);
  } catch (err) {
    logger.error({ err, userId: user.id }, "Loading settings failed");
  }
  const byKey = new Map(settings?.map((s) => [s.key, s]));
  return (
    <AdminFrame user={user} section="settings">
      <PageTitle title="Settings" description="Changes apply immediately, without a restart, and are recorded in the audit log." />
      {!settings ? (
        <AdminError message="Settings couldn't be loaded right now." retryHref="/admin/settings" />
      ) : (
        <>
          {SETTING_GROUPS.map((group) => (
            <section key={group.id} aria-labelledby={`group-${group.id}`} className="rounded-xl border bg-card p-5">
              <h2 id={`group-${group.id}`} className="mb-4 text-sm font-medium">
                {group.title}
              </h2>
              <div className="divide-y">
                {SETTING_SPECS.filter((s) => s.group === group.id).map((spec) => {
                  const current = byKey.get(spec.key);
                  return current ? <SettingForm key={spec.key} spec={spec} value={current.value} editable={current.editable} /> : null;
                })}
              </div>
            </section>
          ))}
          <section aria-labelledby="email-heading" className="rounded-xl border bg-card p-5">
            <h2 id="email-heading" className="mb-2 text-sm font-medium">
              Email
            </h2>
            <p className="text-sm text-muted-foreground">
              Email delivery is configured with environment variables on the server (<code>SMTP_*</code>) and can&apos;t be changed here. The
              Overview shows whether it is configured.
            </p>
          </section>
        </>
      )}
    </AdminFrame>
  );
}
