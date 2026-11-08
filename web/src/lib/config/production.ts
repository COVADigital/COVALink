import "server-only";
import path from "node:path";
import { BUILD_PHASE, envSchema } from "@/lib/env";

/**
 * Production start-up validation. Runs from `instrumentation.ts` before
 * the server accepts requests, so a misconfigured container exits at once
 * instead of failing on first use. Issues name the setting and the rule
 * broken, never the value: secrets and connection strings are not echoed.
 */

/**
 * Accepts an `http://` loopback `APP_URL` (127.0.0.1, localhost, [::1]).
 * Only for isolated smoke verification on one host; never in a deployment.
 */
export const LOOPBACK_APP_URL_FLAG = "COVALINK_ALLOW_LOOPBACK_APP_URL";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Placeholders shipped in `.env.example`; never valid secrets. */
const PLACEHOLDER_SECRETS = new Set(["replace-with-at-least-32-random-characters"]);
const MIN_SECRET_LENGTH = 32;

export interface ConfigIssue {
  setting: string;
  problem: string;
}

type Source = Record<string, string | undefined>;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function checkAppUrl(source: Source, add: (problem: string) => void) {
  const raw = source.APP_URL;
  if (!raw) return add("is required");
  const url = parseUrl(raw);
  if (!url) return add("is not a valid URL");
  if (url.username || url.password) add("must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) add("must be an origin only (no path, query or fragment)");
  if (url.protocol === "https:") return;
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (loopback && source[LOOPBACK_APP_URL_FLAG] === "true") return;
  add(
    loopback
      ? `must use https (an http loopback URL is accepted only with ${LOOPBACK_APP_URL_FLAG}=true, for isolated smoke verification)`
      : "must use https",
  );
}

function checkDatabaseUrl(source: Source, add: (problem: string) => void) {
  const raw = source.DATABASE_URL;
  if (!raw) return add("is required");
  const url = parseUrl(raw);
  if (!url || (url.protocol !== "postgres:" && url.protocol !== "postgresql:")) {
    return add("must be a postgres:// or postgresql:// URL");
  }
  if (!url.hostname) add("must name a host");
  if (url.pathname.length <= 1) add("must name a database");
}

function checkSecret(source: Source, name: string, required: boolean, add: (problem: string) => void) {
  const value = source[name];
  if (!value) {
    if (required) add("is required");
    return;
  }
  if (value.length < MIN_SECRET_LENGTH) add(`must be at least ${MIN_SECRET_LENGTH} characters`);
  if (PLACEHOLDER_SECRETS.has(value)) add("is still the .env.example placeholder");
}

/** Every problem with a production environment; empty when it is safe to start. */
export function productionConfigIssues(source: Source): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const reporter = (setting: string) => (problem: string) => issues.push({ setting, problem });

  if (source.NODE_ENV !== "production") reporter("NODE_ENV")("must be production");
  // The build-phase placeholders in lib/env.ts must never apply to a running server.
  if (source.NEXT_PHASE === BUILD_PHASE) reporter("NEXT_PHASE")("must not be the build phase on a running server");
  checkAppUrl(source, reporter("APP_URL"));
  checkDatabaseUrl(source, reporter("DATABASE_URL"));
  checkSecret(source, "BETTER_AUTH_SECRET", true, reporter("BETTER_AUTH_SECRET"));
  checkSecret(source, "SETUP_TOKEN", false, reporter("SETUP_TOKEN"));

  if ((source.STORAGE_DRIVER || "local") !== "local") reporter("STORAGE_DRIVER")("must be local");
  const storagePath = source.STORAGE_LOCAL_PATH;
  if (!storagePath) reporter("STORAGE_LOCAL_PATH")("is required in production (an absolute path on a persistent volume)");
  else if (!path.isAbsolute(storagePath)) reporter("STORAGE_LOCAL_PATH")("must be an absolute path");

  // Required verification without mail would create accounts that can never verify.
  if (["true", "1"].includes(source.REQUIRE_EMAIL_VERIFICATION ?? "")) {
    if (!source.SMTP_HOST?.trim()) reporter("SMTP_HOST")("is required when REQUIRE_EMAIL_VERIFICATION is enabled");
    if (!source.SMTP_FROM?.trim()) reporter("SMTP_FROM")("is required when REQUIRE_EMAIL_VERIFICATION is enabled");
  }

  // Bounded numbers, booleans and enums: the same schema the app parses lazily.
  // Settings already reported above aren't repeated.
  const reported = new Set(issues.map((i) => i.setting));
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const setting = issue.path.join(".");
      if (reported.has(setting)) continue;
      reported.add(setting);
      issues.push({ setting, problem: issue.message });
    }
  }
  return issues;
}

/** One log line naming each invalid setting. Never contains values. */
export function formatConfigIssues(issues: ConfigIssue[]): string {
  return `Invalid production configuration: ${issues.map((i) => `${i.setting} ${i.problem}`).join("; ")}`;
}
