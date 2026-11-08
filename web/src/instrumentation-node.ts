import { formatConfigIssues, productionConfigIssues } from "@/lib/config/production";
import { closeKeepAliveConnectionsOnShutdown } from "@/lib/server/shutdown";

/**
 * Production server start-up (skipped in `next dev`, NODE_ENV=development;
 * `next build` doesn't call it):
 * 1. an invalid configuration exits with code 78 (EX_CONFIG) and one log line
 *    naming the settings, never their values;
 * 2. keep-alive connections are released on shutdown (lib/server/shutdown.ts).
 */
export function startProductionServer(): void {
  if (process.env.NODE_ENV !== "production") return;
  const issues = productionConfigIssues(process.env);
  if (issues.length > 0) {
    // Plain stderr (not the app logger) so the line is written before exiting.
    process.stderr.write(
      `${JSON.stringify({ level: "fatal", service: "covalink", msg: formatConfigIssues(issues), settings: issues.map((i) => i.setting) })}\n`,
    );
    process.exit(78);
  }
  closeKeepAliveConnectionsOnShutdown();
}
