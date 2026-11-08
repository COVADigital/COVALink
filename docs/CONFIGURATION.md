# Configuration reference

COVALink reads all of its configuration from environment variables. In production they come from Coolify's Environment Variables page or from an env file passed to Docker Compose ([DEPLOYMENT.md](DEPLOYMENT.md#3-configuration)). In development they come from `web/.env`, copied from `web/.env.example`.

Installation settings that administrators change in the application (registration, profile limits, media limits, analytics retention) are stored in the database. The variables marked "default for the setting" below only supply the value until an administrator saves one.

## Production variables

These are the variables `compose.prod.yaml` reads.

| Variable | Required | Secret | Default | Notes |
|---|---|---|---|---|
| `APP_URL` | **yes** | no | none | The public **https origin** only, for example `https://links.example.com`. Used for authentication callbacks, origin checks, links in email and canonical URLs. |
| `SERVICE_PASSWORD_64_POSTGRES` | plain host: **yes** | **yes** | Coolify generates it | Passed to PostgreSQL as `POSTGRES_PASSWORD`. Use a URL-safe value, because it's embedded in the database URL. It takes effect only when `pgdata` is first created; changing it later also needs `ALTER ROLE`. |
| `SERVICE_BASE64_64_AUTHSECRET` | plain host: **yes** | **yes** | Coolify generates it | Passed to the app as `BETTER_AUTH_SECRET`. At least 32 characters. Changing it signs everyone out. |
| `SERVICE_BASE64_64_SETUPTOKEN` | plain host: **yes** | **yes** | Coolify generates it | Passed to the app as `SETUP_TOKEN`, for the one-time `/setup`. Setup can't be reused while the database exists. |
| `POSTGRES_USER` / `POSTGRES_DB` | no | no | `covalink` / `covalink` | |
| `REGISTRATION_ENABLED` | no | no | `false` | Default for the public sign-up setting. |
| `REQUIRE_EMAIL_VERIFICATION` | no | no | `false` | When `true`, new accounts must verify their email address before signing in, and `SMTP_HOST` and `SMTP_FROM` are required. |
| `MAX_PROFILES_PER_USER` | no | no | `5` | 1–100. Default for the setting. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_FROM` | no | no | empty | Email delivery ([EMAIL_DELIVERY.md](EMAIL_DELIVERY.md)). A blank `SMTP_PORT` means 465 with `SMTP_SECURE=true`, otherwise 587. Without a host and a from address, no mail is sent. |
| `SMTP_PASSWORD` | no | **yes** | empty | |
| `MEDIA_QUOTA_MB` / `MEDIA_UPLOADS_PER_HOUR` | no | no | `50` / `30` | Defaults for the per-user media settings: 1–10240 MiB and 1–1000 uploads. |
| `ANALYTICS_RETENTION_DAYS` | no | no | `395` | 1–3650. Default for the retention setting. Old analytics are deleted only when `analytics:purge` runs ([DEPLOYMENT.md](DEPLOYMENT.md#12-analytics-retention)). |
| `TRUST_PROXY` | no | no | **`false`** | Set `true` only after the check in [DEPLOYMENT.md](DEPLOYMENT.md#trust_proxy). |
| `LOG_LEVEL` | no | no | `info` | Logs are JSON lines on standard output and never include secrets or connection strings. |
| `COVALINK_IMAGE` / `COVALINK_IMAGE_TAG` | no | no | `covalink` / `local` | **Set `COVALINK_IMAGE_TAG` to the git commit SHA you deploy.** It gives each deployment an immutable image tag for rollback, and it's recorded in the image label, in backup manifests and as the version on the administration status page. |
| `APP_MEMORY_LIMIT`, `APP_CPUS`, `APP_PIDS_LIMIT`, `APP_TMP_SIZE`, `APP_NEXT_CACHE_SIZE` | no | no | `1g`, `2`, `256`, `256m`, `64m` | [DEPLOYMENT.md](DEPLOYMENT.md#9-resource-limits). Swap is disabled beyond `APP_MEMORY_LIMIT`. |
| `DB_MEMORY_LIMIT`, `DB_CPUS`, `DB_PIDS_LIMIT` | no | no | `512m`, `1`, `256` | |

**Set by `compose.prod.yaml`, not configurable:**
- `DATABASE_URL`, built from the `POSTGRES_*` values with host `db`;
- `STORAGE_DRIVER=local`;
- `STORAGE_LOCAL_PATH=/data/uploads`.

**Never set in a deployment:** `COVALINK_ALLOW_LOOPBACK_APP_URL`. It exists only for local verification on `http://localhost` (`compose.smoke.yaml` and the test runners).

**Required values have no default text.** `compose.prod.yaml` writes required variables as a bare `${VAR:?}`, because Coolify stores any text after `:?` as the variable's initial value, and a message there could become a known password.

## Application variables

These are what the application itself reads (`web/src/lib/env.ts`). In production, `compose.prod.yaml` maps the variables above onto them. In development, set them in `web/.env`.

| Variable | Notes |
|---|---|
| `NODE_ENV` | `development` locally, `production` in the image. |
| `APP_URL` | `http://localhost:3000` in development. Production requires https. |
| `DATABASE_URL` | A PostgreSQL URL. On Windows, use `127.0.0.1` rather than `localhost` ([DEVELOPMENT.md](DEVELOPMENT.md#1-first-time-setup)). |
| `BETTER_AUTH_SECRET` | At least 32 random characters. |
| `SETUP_TOKEN` | At least 32 characters. Unset means `/setup` is disabled. |
| `REGISTRATION_ENABLED`, `REQUIRE_EMAIL_VERIFICATION`, `MAX_PROFILES_PER_USER` | As above. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | As above. In development, the Mailpit mail catcher in `compose.dev.yaml` accepts SMTP on `127.0.0.1:1025` and shows messages at `http://localhost:8025`; without SMTP, development logs the message text, links included. |
| `STORAGE_DRIVER` | Only `local` exists. |
| `STORAGE_LOCAL_PATH` | Where uploaded media is stored. A relative path is resolved from `web/` in development; production requires an absolute path on a persistent volume. |
| `MEDIA_QUOTA_MB`, `MEDIA_UPLOADS_PER_HOUR`, `ANALYTICS_RETENTION_DAYS` | As above. |
| `TRUST_PROXY` | As above. Keep `false` locally. |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `COVALINK_GIT_SHA` | Set by the image build from `GIT_SHA`; shown as the version on the status page. Anything other than letters, digits, `.`, `_` or `-` shows as "Unknown". |
| `TEST_DATABASE_URL`, `E2E_DATABASE_URL` | Test databases only ([DEVELOPMENT.md](DEVELOPMENT.md#test-databases)). |

## Start-up validation

A production server (`NODE_ENV=production`) checks its configuration before it serves any request. If a check fails, it logs one JSON line naming the settings (`APP_URL`, `BETTER_AUTH_SECRET` and so on), never their values, and exits with **code 78**. It checks that:

- `NODE_ENV=production`;
- `APP_URL` is an https origin;
- `DATABASE_URL` is a structurally valid PostgreSQL URL;
- `BETTER_AUTH_SECRET` has at least 32 characters and isn't the `.env.example` placeholder;
- `STORAGE_DRIVER=local`, and `STORAGE_LOCAL_PATH` is absolute;
- every bounded number is in range;
- `REQUIRE_EMAIL_VERIFICATION=true` comes with `SMTP_HOST` and `SMTP_FROM`.

On Coolify, read the message in the `app` container's logs.
