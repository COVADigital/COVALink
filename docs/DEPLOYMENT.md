# Deploying COVALink

This guide installs COVALink on a Docker Compose host or on Coolify, by building the image from this repository. No published container image is supported yet (see the [README](../README.md#project-status)).

**Topology:** one app replica, one PostgreSQL database and two persistent volumes.

**What has been tested:** the image, the Compose file, its hardening, health checks, persistence, memory limits, shutdown, migrations and backup and restore are exercised by `npm run test:deploy` on Docker Engine with Compose v2 (linux/amd64), using throwaway Compose projects. Behavior that is specific to Coolify is documented from Coolify's own documentation and hasn't been verified on a Coolify instance. linux/arm64 is supported by the base image and sharp, but no arm64 image has been built and tested.

## 1. What runs

| Service | Image | Role | Network | Storage |
|---|---|---|---|---|
| `db` | `postgres:17.11-alpine3.24` (pinned digest) | PostgreSQL | `backend` (internal, no route out) | volume `pgdata` |
| `migrate` | the COVALink image | one-shot: `node scripts/migrate.mjs`, then exits 0 | `backend` | none |
| `app` | the same COVALink image | Next.js server on port 3000 | `backend` and `edge` | volume `media` at `/data/uploads` |

**Start order and ports:**
- `app` starts only after `db` is healthy and `migrate` has exited successfully.
- No service publishes a host port. Port 3000 is exposed only on the Compose network, for the reverse proxy.
- PostgreSQL is reachable only by `migrate` and `app`.

**On Coolify:** Coolify adds its own resource network to every service, and its `.env` file reaches every service. So on Coolify, `db` and `migrate` also get outbound network access and secrets they don't use. No service publishes a host port there either, and only `app` gets a proxy route. The isolation in the table is what `compose.prod.yaml` declares and what a plain Compose host gets.

**Hardening:** `migrate` and `app` both run as uid/gid 1000 with:
- `read_only: true`;
- `ipc: none` (no `/dev/shm`);
- `init: true` (Docker's tini as PID 1);
- `cap_drop: [ALL]` and `no-new-privileges`;
- a bounded `pids_limit`.

**Writable paths in `app`:** exactly three.
- `/tmp`: a uid-1000 tmpfs.
- `/app/.next/cache`: a uid-1000 tmpfs.
- `/data/uploads`: the media volume.

**Single replica only.** Don't scale `app` beyond one container. Each of these is local to one process:
- uploaded media (a local volume);
- the image-decode limit and upload deadlines;
- Next.js's in-memory cache and its invalidation.

## 2. Requirements

- **Docker Engine with BuildKit.** It's the default since Docker 23. The Dockerfile uses `RUN --network=none`.
- **Docker Compose v2**, for these features:
  - `depends_on` with `service_completed_successfully`;
  - the `ipc`, `memswap_limit`, `pull_policy` and `tmpfs` options.
- **A linux/amd64 or linux/arm64 host.** The pinned Node.js image and sharp's musl binaries cover both.
- **Memory:** about 1.6 GiB for the containers at the default limits (app 1 GiB, db 512 MiB, and migrate 256 MiB while it runs), plus the host's own needs.
- **A TLS-terminating reverse proxy** in front of the app. Coolify provides one (Traefik).

## 3. Configuration

Everything comes from the environment:
- **Coolify:** its Environment Variables page.
- **Plain Docker host:** an env file passed with `--env-file`. Keep it outside the repository, with mode 0600, and never commit it.

Nothing secret is in the image, the Compose file or the repository, and the image build needs no environment and no secrets. [CONFIGURATION.md](CONFIGURATION.md) lists every variable.

**Required on a plain host:** `SERVICE_PASSWORD_64_POSTGRES`, `APP_URL`, `SERVICE_BASE64_64_AUTHSECRET` and `SERVICE_BASE64_64_SETUPTOKEN`. Generate the three secrets with `openssl rand -hex 32`; hex is URL-safe, which matters because the database password is embedded in the database URL. **On Coolify,** `APP_URL` is the only required value you supply: Coolify generates the three secrets once and keeps them across redeployments.

**Start-up validation:** a misconfigured production `app` exits with **code 78** before it serves any request. It logs one JSON line naming the settings that are wrong, never their values. [CONFIGURATION.md](CONFIGURATION.md#start-up-validation) lists the checks.

### TRUST_PROXY

**Default: `false`.** No client-supplied header is trusted, and every client shares one rate-limit bucket per authentication endpoint. That's safe but strict: for example, five sign-in attempts per minute for the whole site.

**What `true` does:** the client address used for per-client rate limits, and for analytics visitor counts, comes from `X-Forwarded-For` (a single value) or else `X-Real-IP`. Whoever can set those headers chooses their own identity.

**Set `true` only when all of these hold:**
- the proxy in front **overwrites** `X-Forwarded-For` and `X-Real-IP` with the connecting client's address, rather than appending to them or passing them through;
- port 3000 can't be reached except through that proxy: no published port, no firewall exception, and no other untrusted container on a shared network (Coolify's "Connect to Predefined Network" option puts the stack on a network that Coolify's other resources use);
- you've run the check below.

Behind any other proxy, with direct access, or if you aren't sure, keep `false`. With `true` in those cases, clients could spoof their address and evade per-client rate limits.

**Check, after deploying with `TRUST_PROXY=true`.** Send one failed sign-in with spoofed headers through the public domain, from a machine outside the server:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<domain>/api/auth/sign-in/email \
  -H 'origin: https://<domain>' -H 'content-type: application/json' \
  -H 'x-forwarded-for: 203.0.113.99' -H 'x-real-ip: 203.0.113.99' \
  -d '{"email":"nobody@example.com","password":"not-a-real-password"}'      # 401
# -U / -d: your POSTGRES_USER / POSTGRES_DB
docker exec <db container> psql -U covalink -d covalink -Atc \
  "select key from rate_limits where key like '%|/sign-in/email'"
```

- **Pass:** there's a key with your machine's real public address, and none with `203.0.113.99`.
- **Fail:** a key with `203.0.113.99` means the proxy passes client headers through. Set `TRUST_PROXY=false` and redeploy.

Repeat the check after changing the proxy configuration, for example after adding a CDN in front of Traefik or changing trusted-IP settings.

**Effect on analytics:**
- **With `false`:** views and clicks are still counted exactly. Views are stored without a visitor hash, so the dashboard shows visitors as unavailable and repeat views aren't suppressed. Analytics ingestion is limited per profile and installation-wide only.
- **With `true` behind a verified proxy:** visitors are counted approximately, repeat views within 30 minutes are dropped, and each visitor is limited separately.
- **With `true` without a verified proxy:** clients choose their own visitor identity, the same risk as for rate limits.

## 4. Plain Docker Compose host

Run these commands from a checkout of this repository on the server.

1. Prepare an env file outside the repository:

   ```sh
   install -m 600 /dev/null /etc/covalink/covalink.env
   # Edit it: SERVICE_PASSWORD_64_POSTGRES, APP_URL,
   # SERVICE_BASE64_64_AUTHSECRET, SERVICE_BASE64_64_SETUPTOKEN,
   # COVALINK_IMAGE_TAG=<git commit SHA> ...
   # Leave TRUST_PROXY unset (false) until the check in "TRUST_PROXY" passes.
   ```

2. Build the image. It needs no database and no secrets, and `next build` runs with no network:

   ```sh
   docker compose -p covalink -f compose.prod.yaml --env-file /etc/covalink/covalink.env build app
   ```

3. Start the stack, then check it:

   ```sh
   docker compose -p covalink -f compose.prod.yaml --env-file /etc/covalink/covalink.env up -d
   docker compose -p covalink -f compose.prod.yaml --env-file /etc/covalink/covalink.env ps   # app: healthy; migrate: exited (0)
   docker compose -p covalink -f compose.prod.yaml --env-file /etc/covalink/covalink.env logs migrate
   ```

4. Put a TLS-terminating reverse proxy in front of `app:3000`; it should send HSTS. Then do the first-time setup (section 6).
5. Optional: if the proxy overwrites `X-Forwarded-For` and `X-Real-IP`, set `TRUST_PROXY=true`, run `up -d` again, and run the check in [TRUST_PROXY](#trust_proxy).

## 5. Coolify

> **Requires Coolify v4.6.0 or later.** Earlier releases don't keep runtime-only required variables available to the Compose build helper. Making the secrets available at build time isn't an acceptable workaround.

1. **Resource:** New Resource → your Git repository → Build Pack **Docker Compose**.
   - Source: this repository, or your fork of it.
   - Branch: `master`, or the release tag you're deploying.
   - Base Directory: `/`
   - Docker Compose Location: `/compose.prod.yaml`
   - Coolify reads the file and lists `db`, `migrate` and `app`.
   - **Don't** add `compose.smoke.yaml`.
2. **Domain:** on the **`app`** service, set the domain with the container port, for example `https://links.example.com:3000`. Coolify's Traefik routes that domain to `app:3000` and obtains a certificate. Leave `db` and `migrate` without domains.
3. **Resource settings, before the first deployment** (names follow Coolify's documentation; yours may differ slightly):

   | Setting | Where | Value | Why |
   |---|---|---|---|
   | Automatic deployments | Advanced | **Off** | It defaults to on. A push would deploy without a backup (section 8) and with a stale `COVALINK_IMAGE_TAG`. |
   | Preview deployments | Preview Deployments | **Off** | They would run this stack for pull requests. |
   | Build arguments | Advanced > Build | **Managed manually in Dockerfile** | Otherwise Coolify injects an `ARG` for every variable available during the build. Only `GIT_SHA` is passed, by `compose.prod.yaml`. |
   | Source commit availability | Advanced > Build | The default (not available during build) | The version comes from `COVALINK_IMAGE_TAG`. |
   | Predefined network | Advanced > Docker compose | **Not connected** | Connecting joins the shared Coolify network (see [TRUST_PROXY](#trust_proxy)). |

4. **Environment variables:**
   - Set `APP_URL` to exactly the https domain from step 2, without the port.
   - Confirm that Coolify generated non-empty values for `SERVICE_PASSWORD_64_POSTGRES`, `SERVICE_BASE64_64_AUTHSECRET` and `SERVICE_BASE64_64_SETUPTOKEN`. Store them in a password manager or secret store (see [BACKUP_RESTORE.md](BACKUP_RESTORE.md#1-what-a-complete-backup-is)). Don't replace them unless you're deliberately rotating a credential.
   - Review each variable in Normal view rather than Developer view, so generated values aren't replaced by accident.
   - **Build time:** set `APP_URL`, the three generated secrets and every other runtime setting to **Not available during build**. Keep only `COVALINK_IMAGE_TAG` (and `COVALINK_IMAGE`, if you set it) available, because Compose uses them to name and label the image. New Coolify variables default to being available at build time.
   - Mark `SMTP_PASSWORD` hidden if you configure email. Treat the generated `SERVICE_*` values as secrets, and restrict who can see Coolify's environment through team permissions.
   - Set `COVALINK_IMAGE_TAG` to the commit SHA you're deploying.
   - **`TRUST_PROXY`:** leave it unset (`false`) for the first deployment. Set it to `true` only after the check in [TRUST_PROXY](#trust_proxy) passes on your instance, then redeploy.
5. **Persistent storage:** Coolify creates the named volumes `pgdata` and `media`, prefixed with the resource's identifier, and keeps them across redeployments. Never choose to delete volumes when removing or recreating the resource unless you mean to destroy the data.
6. **Before deploying, inspect Coolify's generated Compose file.** Check that:
   - the three generated `SERVICE_*` values are present, without copying them into logs or messages;
   - `APP_URL` and the three generated secrets aren't available during the build, and build arguments are still managed manually;
   - `migrate` and `app` name the same image, and `migrate` keeps `pull_policy: never`;
   - the hardening settings in section 1 are present;
   - which networks each service is on.
7. **Deploy.** Coolify builds the image and runs `docker compose up`. `migrate` should exit 0, and `app` becomes **healthy** once `/api/ready` returns 200. Coolify may show `migrate` as exited, which is correct for a one-shot service.
8. **HSTS:** add it once HTTPS works (below).
9. **Install the operator scripts on the host** (below) and run a backup and restore drill ([BACKUP_RESTORE.md](BACKUP_RESTORE.md#5-restore)).

**After the first deployment, check on your instance:**
- **Start order:** `app` is created only after `migrate` succeeds (`docker ps -a` on the server).
- **The built image:** its labels and `docker history --no-trunc` contain no secret value.
- **Networks:** `docker inspect -f '{{json .NetworkSettings.Networks}}' <db container>`. `db` must have no published port.
- **Hardening:** `docker inspect <app container>` shows `read_only`, `ipc: none`, the uid-1000 tmpfs mounts and `memswap_limit`, and `docker exec <app container> id -u` prints `1000`.
- **Image tag:** `docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' <app container>` prints the SHA you set, and the administration status page shows the same version.
- **Persistence:** redeploy after the first-time setup, then confirm that accounts, a published profile and its images are all still there.

**Finding `<compose-project>`** (needed by `ops/backup.sh` and `ops/restore.sh`):

```sh
docker ps --format '{{.Names}}  {{.Label "com.docker.compose.project"}}' | grep app
```

Use exactly the value this prints. Don't assume it matches the resource identifier shown in Coolify: the scripts find their containers by this label, so a wrong value can stop a backup or target the wrong stack in a restore.

### Operator scripts on the host

Backups and restores run on the Docker host, outside any container. Coolify's deployment checkout belongs to Coolify, which doesn't keep it, so keep a separate checkout at a stable path:

```sh
# Once, on the server, as an account allowed to run docker.
git clone https://github.com/COVADigital/COVALink.git /opt/covalink-ops
install -d -m 700 /srv/backups/covalink

# Before each backup or restore: use the scripts from the commit that's running.
git -C /opt/covalink-ops fetch --prune origin
git -C /opt/covalink-ops checkout --detach <deployed commit SHA>
```

- This checkout holds only tracked files. Never put an env file or secrets in it.
- Use it for `ops/*.sh` and for the Compose file used by a restore drill. Coolify keeps deploying from its own checkout.

### HSTS (Traefik, once HTTPS works)

The app doesn't send `Strict-Transport-Security`. Add it at Traefik, in stages, once the domain serves valid HTTPS. These steps follow Coolify's custom-middleware documentation.

1. **Define it:** Servers → your server → Proxy → Dynamic Configurations, a new file `covalink-hsts.yaml`:

   ```yaml
   http:
     middlewares:
       covalink-hsts:
         headers:
           stsSeconds: 300
           stsIncludeSubdomains: false
           stsPreload: false
   ```

2. **Attach it:** add this to the `app` service in your copy of `compose.prod.yaml`, then deploy. Define the middleware first: a router that names a missing middleware stops working.

   ```yaml
       labels:
         - coolify.traefik.middlewares=covalink-hsts@file
   ```

3. **Check it:** `curl -sI https://<domain>/ | grep -i strict-transport-security` shows exactly one header with the expected `max-age`, and `http://<domain>/` redirects to https.
4. **Raise it** by editing only the dynamic file, keeping each stage long enough to be confident: `300` → `86400` (a day) → `2592000` (30 days) → `31536000` (a year).

**Don't** copy the wider example from Coolify's documentation. `stsIncludeSubdomains` and preload commit every subdomain and are hard to undo, and the other headers there aren't part of COVALink's header set ([SECURITY.md](../SECURITY.md#security-headers)).

**Backing out:** browsers remember the policy for the last `max-age` they saw. Replace the `sts*` settings with `customResponseHeaders: { Strict-Transport-Security: "max-age=0" }`, and keep that until the last `max-age` has passed.

## 6. First-time setup

1. Deploy with `SERVICE_BASE64_64_SETUPTOKEN` set. Coolify generates it; on a plain host it's in your env file.
2. Open `https://<domain>/setup`. Enter the setup token and the administrator's name, email and password.
3. After setup succeeds, `/setup` stays closed for as long as that database exists. The token stays configured. If the `pgdata` volume is lost or replaced with an empty one, setup opens again to anyone who has the token, so rotate it if it was shared beyond trusted operators. Never publish it or include it in logs.

Public sign-up stays closed until setup completes. After that it follows `REGISTRATION_ENABLED` and the administrator's settings.

## 7. Health checks

| Check | Where | Endpoint | What it means |
|---|---|---|---|
| **Liveness** | the image's `HEALTHCHECK`, used when the image runs without Compose (for example `docker run`) | `/api/health` | The process serves HTTP. It never touches PostgreSQL. |
| **Readiness**, the traffic gate for Coolify and Traefik | the `app` healthcheck in `compose.prod.yaml`, which overrides the image's | `/api/ready` | PostgreSQL answers within 2 s, **and** a probe file can be created and deleted in `/data/uploads`. |

Both run `node scripts/healthcheck.mjs [ready]`, which requests `127.0.0.1:3000` with a 4 s timeout and prints only the status. The image has no curl.

**Behavior:**
- **Database outage:** `/api/ready` returns 503 with `{"database":"timeout"|"unavailable","storage":"ok"}`, while `/api/health` stays 200. Readiness recovers when the database returns.
- **Unwritable media volume:** `/api/ready` returns 503 with `{"storage":"unavailable"}`.
- **Response bodies** use only that fixed vocabulary: no hosts, messages or secrets.
- **During start-up,** readiness succeeds only after the migrator has completed and the media volume is writable.

**The administration status page** shows the same database and storage checks, plus the version, the migration count, whether email is configured, and the analytics retention. It needs the database to sign you in, so during a database outage it's unavailable: `/api/ready` is the authoritative outage signal.

**Docker never restarts a container for being unhealthy.** The restart policy (`unless-stopped`) applies only when the process exits, so a database outage withdraws traffic without a restart loop. While `app` is unhealthy, Traefik stops routing to it, and visitors get Traefik's error page instead of the app's.

## 8. Upgrades

1. **Take a backup first** with `ops/backup.sh` ([BACKUP_RESTORE.md](BACKUP_RESTORE.md#2-authoritative-backup-consistent)). Nothing takes a backup automatically before a deployment.
2. Check [BACKUP_RESTORE.md](BACKUP_RESTORE.md#rollback) for any migration the new version adds, and whether the previous version can still run after it.
3. Deploy the new commit or release with `COVALINK_IMAGE_TAG` set to its SHA. The new image's `migrate` runs before the new `app` starts.
   - **Migrations are forward-only.** Pending ones are applied in one transaction under an advisory lock.
   - On failure, the migrator prints one bounded line (an error code and a scrubbed message), never the connection string or password.
4. Check that `app` is healthy, that `/api/ready` returns 200 through the domain, that the image label shows the new SHA, and that the logs show no errors.

**If the new image's migration fails:**
- **The database is unchanged,** because the migration transaction rolls back.
- **A plain `docker compose up -d` leaves the site down:** Compose has already removed the old `app` container and created the new one, which it doesn't start.
- **Recover by redeploying the previous tag** (`COVALINK_IMAGE_TAG=<previous SHA>`, then `up -d`). That's safe because nothing was migrated.

**On a plain host, run the migrator first, while the old app keeps serving:**

```sh
# The new image is built and tagged; the old app is still running.
docker compose -p covalink -f compose.prod.yaml --env-file <env with the NEW tag> run --rm migrate
# Only if that exits 0:
docker compose -p covalink -f compose.prod.yaml --env-file <env with the NEW tag> up -d
```

A failing migration then exits 1 and leaves the old app serving. This relies on the expand/contract rule ([BACKUP_RESTORE.md](BACKUP_RESTORE.md#rollback)), because the old code runs briefly against the new schema.

**On Coolify,** deployment uses Compose, so expect the plain `up -d` behavior: a failed migration fails the deployment and takes the app down, and you recover by redeploying the previous commit. With automatic deployments off, each upgrade is:

1. Update the operator checkout to the commit that's running, and find `<compose-project>` (section 5).
2. Back up, encrypt and copy the backup off the host. The app stops briefly:

   ```sh
   /opt/covalink-ops/ops/backup.sh --project <compose-project> --out /srv/backups/covalink
   ```

3. Check the migration table in [BACKUP_RESTORE.md](BACKUP_RESTORE.md#rollback).
4. In Coolify, set `COVALINK_IMAGE_TAG` to the new commit's SHA and deploy that commit.
5. Run the checks in step 4 above.

## 9. Resource limits

| Service | Memory | Swap | CPUs | PIDs | tmpfs |
|---|---|---|---|---|---|
| `app` | `APP_MEMORY_LIMIT` (1g) | none beyond the limit | `APP_CPUS` (2) | 256 | `/tmp` 256m and `/app/.next/cache` 64m, both counted against the memory limit |
| `db` | `DB_MEMORY_LIMIT` (512m) | Docker default | 1 | 256 | none |
| `migrate` | 256m | Docker default | none set | 64 | none |

**Measured** with `npm run test:deploy` (linux/amd64, a 1 GiB app limit, no swap):
- **Idle app:** about 89 MiB.
- **Worst case:** four concurrent uploads of the largest allowed input, an 8000 × 5000 (40 megapixel) 16-bit RGBA PNG that needs a full decode. Two were decoded while two waited. All four succeeded with no out-of-memory kill, and memory peaked at 442 MiB (43%).
- libvips runs one worker thread per image. With its default thread pool, sized from the host's cores, two such decodes needed about 1 GiB on a 32-core host.

**Don't lower `APP_MEMORY_LIMIT` below about 768m:** legitimate large uploads would risk an out-of-memory kill, and `/tmp` usage also counts against the limit.

## 10. Pinned images

| Use | Reference |
|---|---|
| Build and runtime base (`web/Dockerfile`, `NODE_IMAGE`) | `node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85` |
| PostgreSQL (`compose.prod.yaml`), and the backup, restore and inspection helper (`ops/lib.sh`, `web/tests/deploy/smoke.mjs`) | `postgres:17.11-alpine3.24@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b` |

`compose.dev.yaml` is for development only, and its images aren't pinned.

**Temporary Alpine security update.** No official Node 24 Alpine image yet ships zlib 1.4, which fixes CVE-2026-4738. Until one does, COVALink applies Alpine's own security update on top of the pinned base image. The first stage of `web/Dockerfile`, `patched-base`:
- installs exactly `zlib=1.4-r0` from Alpine's repositories, with apk's normal signature verification;
- fails the build if that exact package can't be retrieved or verified, if another version ends up installed, or if any other package changes.

Every later stage, both build and runtime, builds on `patched-base`. The version is pinned as `ALPINE_ZLIB_VERSION` in `release/config.env`. The candidate's `alpine-security-update` gate checks four things:
- the image has exactly that version installed;
- the SBOM reports it;
- the vulnerability scan no longer reports zlib;
- no vulnerability exception covers zlib or the CVE.

**Removing the update** needs its own dedicated review and proof that the replacement base image already contains zlib 1.4-r0 or newer. Repin `NODE_IMAGE`, show its installed zlib version, and then remove the stage, the pin and the gate together.

**When to update:** monthly, and promptly for a Node.js, Alpine, OpenSSL, libvips or PostgreSQL security release. A PostgreSQL **major** upgrade (17 to 18) isn't a tag change: it needs a dump and restore.

**How to update:**
1. Find the exact patch tag and its manifest-list digest, and confirm that the patch tag and the moving tag resolve to the same digest:
   ```sh
   docker buildx imagetools inspect node:24-alpine           # note "Digest:" and the Node.js version
   docker buildx imagetools inspect node:24.X.Y-alpine3.Z    # must show the same Digest
   docker buildx imagetools inspect postgres:17.X-alpine3.Z
   ```
2. Update every reference: `NODE_IMAGE` in `web/Dockerfile`, the `db` image in `compose.prod.yaml`, `HELPER_IMAGE` in `ops/lib.sh` and `web/tests/deploy/smoke.mjs`, and the table above.
3. Regenerate the third-party notices ([DEVELOPMENT.md](DEVELOPMENT.md#third-party-notices)), because the base image's packages and Node.js version are part of them.
4. Run the full verification in [DEVELOPMENT.md](DEVELOPMENT.md#quality-checks), including `npm run test:deploy`.

## 11. Volume ownership

**A new named volume** mounted at `/data/uploads` takes the image's directory ownership and mode, 1000:1000 and 0700. Nothing else is needed.

**An existing volume owned by root** makes `/api/ready` report `storage: "unavailable"`, and uploads fail. That happens to a volume first used by another container, copied from elsewhere, or a bind mount. Repair it with the pinned helper image:

```sh
docker run --rm --network none -v <volume>:/data --entrypoint sh \
  postgres:17.11-alpine3.24@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b \
  -c 'chown -R 1000:1000 /data && find /data -type d -exec chmod 700 {} + && find /data -type f -exec chmod 600 {} +'
```

A bind mount used instead of the named volume must be owned by uid 1000. Don't change the ownership of PostgreSQL's `pgdata`; the postgres image manages it.

## 12. Analytics retention

Analytics events older than the retention period (the `analytics.retentionDays` setting, which defaults to `ANALYTICS_RETENTION_DAYS`, 395 days) and visitor-hash salts older than yesterday (UTC) are deleted **only when `analytics:purge` runs**. COVALink has no scheduler of its own, so **retention holds only if you schedule the purge**. Daily is enough.

The script is in the image at `scripts/analytics-purge.mjs`. It needs only the database, so it runs in the read-only `app` container. It prints the retention, the two boundaries and two counts, never event data, and exits 0 on success. Running it twice at once, or again later, is harmless.

```sh
docker compose -p covalink -f compose.prod.yaml --env-file <env file> exec -T app node scripts/analytics-purge.mjs --dry-run
docker compose -p covalink -f compose.prod.yaml --env-file <env file> exec -T app node scripts/analytics-purge.mjs
```

**Scheduling:**
- **Plain host:** a daily cron entry, for example `17 3 * * * cd /srv/covalink && docker compose -p covalink -f compose.prod.yaml --env-file /srv/covalink/covalink.env exec -T app node scripts/analytics-purge.mjs >> /var/log/covalink-purge.log 2>&1`.
- **Coolify:** a Scheduled Task on the `app` service, running `node scripts/analytics-purge.mjs` daily.

**Boundaries (database clock, UTC):**
- **Events** are deleted when they're older than the start of the UTC day `today − (retentionDays − 1)`, so the dashboard's longest range is fully kept when the purge has run today.
- **Salts** for today and yesterday are kept. Once older salts are deleted, nobody can recompute those days' visitor hashes.

A restored backup can bring back events and salts the purge had already deleted, so run the purge after restoring an older backup.

## 13. Account email

Email is optional. Without it, password recovery is unavailable, and `REQUIRE_EMAIL_VERIFICATION` must stay `false` (start-up validation enforces this). Keep the administrator's password in a secret store until email works. [EMAIL_DELIVERY.md](EMAIL_DELIVERY.md) covers configuring an SMTP provider and checking delivery.

- **What sends mail:** password-reset links and, with `REQUIRE_EMAIL_VERIFICATION=true`, verification links. Both are valid for one hour, and a reset link works once.
- **Restarts:** delivery runs just after the response, so a message queued just before the container stops can be lost. The person can request another link.
- **Logs:** reset and verification tokens are never in request URLs. They travel in the link's `#fragment` and in request bodies, so proxy access logs don't contain them, and the app never logs them in production.

## 14. Checking video and music embeds in production

Run these checks once after the first deployment, and again after changing the proxy or upgrading COVALink. They need only a public URL and a browser. An administrator first publishes a test profile with the samples below, through the editor, and unpublishes it afterwards. Pressing Load contacts that provider, which can then collect data about you.

| Block | Link |
|---|---|
| Video | `https://www.youtube.com/watch?v=jNQXAC9IVRw` |
| Video | `https://vimeo.com/22439234` |
| Music | `https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC` |
| Music | `https://soundcloud.com/forss/flickermood` |

**1. Headers, with curl from outside the server:**

```sh
curl -sI https://<domain>/<handle> | grep -i -E 'content-security-policy|set-cookie|strict-transport'
curl -sI https://<domain>/login | grep -i content-security-policy
curl -s https://<domain>/<handle> | grep -c '<iframe'
```

- [ ] The profile has **one** Content-Security-Policy, and its `frame-src` is exactly `https://www.youtube-nocookie.com/embed/ https://player.vimeo.com/video/ https://open.spotify.com/embed/ https://w.soundcloud.com/player/`.
- [ ] `/login` has `frame-src 'none'`.
- [ ] The profile sets no cookie, and its HTML has 0 iframes.

**2. In a signed-out private window, with the browser's developer tools open on Network and Console:**

- [ ] **Before Load:** no request to any provider host, and no provider cookies.
- [ ] **Load, by mouse and by keyboard (Enter and Space):** only that block's player appears, and focus moves into it.
- [ ] **The iframe's attributes:** `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`, `referrerpolicy="strict-origin-when-cross-origin"`, and `allow` is `encrypted-media; fullscreen` for video, `encrypted-media` for Spotify, and absent for SoundCloud.
- [ ] **No autoplay** before you press play.
- [ ] **Console:** no Content-Security-Policy violation from the COVALink page itself. Players may log their own messages.
- [ ] **The "Open on" link** opens the provider's page, including with JavaScript disabled.
- [ ] **At 320 and 390 px wide:** no horizontal overflow, and no layout shift when a player loads.

Any failure in part 1, or of a part 2 item other than playback, is a COVALink defect. A sample that won't play while everything else passes is usually a provider issue: open the same link directly on the provider's site to compare.
