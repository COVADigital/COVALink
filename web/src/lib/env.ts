import "server-only";
import { z } from "zod";

const boolish = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  // One-time operator secret that authorizes creating the super administrator
  // at /setup. Unset = setup disabled. Remove it after setup completes.
  SETUP_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.string().min(32, "SETUP_TOKEN must be at least 32 characters").optional()),

  REGISTRATION_ENABLED: boolish,
  REQUIRE_EMAIL_VERIFICATION: boolish,
  MAX_PROFILES_PER_USER: z.coerce.number().int().min(1).max(100).default(5),

  SMTP_HOST: z.string().optional(),
  // Compose passes an unset port as an empty string. Blank means unset, so
  // lib/mail.ts falls back to 465 or 587 (coercing "" would give port 0).
  SMTP_PORT: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v : undefined))
    .pipe(z.coerce.number<string>().int().optional()),
  SMTP_SECURE: boolish,
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  // Media storage root. Must be absolute (a persistent volume) in production.
  STORAGE_LOCAL_PATH: z.string().default("./data/uploads"),
  // Defaults for the `media.quotaMb` / `media.uploadsPerHour` settings.
  MEDIA_QUOTA_MB: z.coerce.number().int().min(1).max(10240).default(50),
  MEDIA_UPLOADS_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),

  // Default for the `analytics.retentionDays` setting; same bounds.
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(395),
  TRUST_PROXY: boolish,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export const BUILD_PHASE = "phase-production-build";

/**
 * `next build` evaluates route modules to collect page data; no request is
 * served and the image build has no network and no environment. In that
 * phase only, missing runtime-only settings get these inert placeholders, so
 * the build needs no secrets: the reserved `.invalid` host never resolves,
 * nothing is prerendered from them (installation-state reads are per request),
 * and a running server can't use them because the production start-up
 * validator refuses `NEXT_PHASE=phase-production-build` and requires real
 * values (`lib/config/production.ts`).
 */
const BUILD_PHASE_PLACEHOLDERS = {
  APP_URL: "https://build-placeholder.invalid",
  DATABASE_URL: "postgresql://build-placeholder.invalid/build_placeholder",
  BETTER_AUTH_SECRET: "build-placeholder-not-a-secret-never-used-at-runtime",
} as const;

function envSource(): Record<string, string | undefined> {
  if (process.env.NEXT_PHASE !== BUILD_PHASE) return process.env;
  const source: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(BUILD_PHASE_PLACEHOLDERS)) source[key] ||= value;
  return source;
}

/**
 * Parsed lazily so that importing a module never throws during `next build`
 * when runtime-only variables are absent; the first real use validates.
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(envSource());
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function smtpConfigured(): boolean {
  const e = env();
  return Boolean(e.SMTP_HOST && e.SMTP_FROM);
}
