# Backup, restore, upgrade and rollback

**Tools:** `ops/backup.sh` and `ops/restore.sh`. They're bash scripts that need only Docker on the host. They also run in Git Bash on Windows.

**Where they run:** on the Docker host. On Coolify, use a separate operator checkout, not Coolify's deployment checkout ([DEPLOYMENT.md](DEPLOYMENT.md#operator-scripts-on-the-host)). The commands below are relative to that checkout.

**What has been tested:** with `npm run test:deploy`, in throwaway Compose projects: a backup of a running stack; refusal of a modified backup and of malicious or malformed manifests with recomputed checksums, with no payload executed; a restore into a fresh stack that serves the same profiles, image bytes and accounts; refusal of an internally inconsistent backup, with the app never started; a restore whose app can't start, which leaves it stopped; an older backup migrated forward onto a newer image; and refusals for a running app and for a non-empty target. These procedures haven't been tested on a Coolify stack.

## 1. What a complete backup is

A COVALink installation has three parts. Back them up **as a set**:

| Part | Where | Backed up by |
|---|---|---|
| PostgreSQL: accounts, sessions, profiles, settings, media records, analytics | volume `pgdata` | `ops/backup.sh` → `database.dump` (`pg_dump -Fc`) |
| Uploaded media (`{hh}/{hh}/{uuid}.webp`) | volume `media` (`/data/uploads`) | `ops/backup.sh` → `media.tar` |
| Configuration and secrets: `SERVICE_PASSWORD_64_POSTGRES`, `SERVICE_BASE64_64_AUTHSECRET`, `SERVICE_BASE64_64_SETUPTOKEN`, `APP_URL`, SMTP settings | Coolify's environment page or your env file | **You.** Save them in a password manager or secret store. The backup scripts never include them. |

**A database backup alone isn't a complete backup.** Images whose records are in the database would be missing, and image files without records are orphans. Always restore the database and media **from the same backup**.

**Restore with the same `SERVICE_BASE64_64_AUTHSECRET`** if existing sessions should stay valid. Password hashes don't depend on it. Also save the database password, which you need to operate the existing PostgreSQL volume, and the setup token.

**Analytics:** analytics events and visitor-hash salts are part of `database.dump`. A backup therefore holds pseudonymous visitor hashes, plus the salts for the day of the backup and the day before. Until those salts are gone, someone with the backup and a candidate IP address could test whether it produced a hash, so protect backups accordingly. A restored older backup brings back events the live purge had deleted, so **run `analytics:purge` after restoring** ([DEPLOYMENT.md](DEPLOYMENT.md#12-analytics-retention)).

## 2. Authoritative backup (consistent)

```sh
ops/backup.sh --project <compose-project> --out /srv/backups/covalink
```

**Finding `<compose-project>`:** on a plain host it's your `docker compose -p` name. On Coolify, read it from the running containers and use exactly the value printed: `docker ps --format '{{.Names}}  {{.Label "com.docker.compose.project"}}'`.

**What the script does:**
1. Finds the stack's `db` and `app` containers by their Compose labels, and the volume mounted at `/data/uploads`.
2. **Stops `app`** with a graceful 60-second drain, so no request can change the database or media during the backup. PostgreSQL keeps running.
3. Writes `database.dump` with `pg_dump -Fc`, run inside `db`.
4. Writes `media.tar`, a copy of the media volume made by a throwaway container of the pinned PostgreSQL image, with the volume mounted read-only and networking disabled.
5. Writes `manifest.json`: the time, project, image reference, image ID and commit, the migration level, the media record and file counts, each archive's size and SHA-256, and `consistency: "app-stopped"`.
6. Writes `SHA256SUMS` covering all three files.
7. **Starts `app` again** and waits up to 180 seconds for readiness. If the script fails, it restarts `app` on every exit path and reports the incomplete directory as **not valid**.

The app is down between steps 2 and 7: seconds to minutes, depending on the database and media size.

**Output:** `<out>/covalink-<project>-<UTC timestamp>/`, created with mode 0700, with every file 0600. It contains no environment files, no Compose files and no secrets beyond what the database itself holds.

### Handling backups

Backups are **security-sensitive**. The database contains password hashes, active session tokens, email addresses and every profile, and the media archive contains people's images.

- **Location:** store backups outside the `pgdata` and `media` volumes, and outside anything a web server serves.
- **Permissions:** keep the 0700 directories and 0600 files the script creates.
- **Encryption:** encrypt each backup before it leaves the host, for example with `age`:
  ```sh
  tar -C /srv/backups/covalink -cf - covalink-<project>-<stamp> | age -r <recipient public key> > covalink-<stamp>.tar.age
  ```
- **Off-host copy:** copy the encrypted file to another machine or to object storage. A backup on the same disk doesn't survive losing that disk.
- **Integrity isn't authenticity:** the checksums detect corruption, **not tampering**. Anyone who can write a backup directory can change it and recompute every checksum. Restore only backups from storage that only you can write. To prove origin, sign the encrypted file (for example with `ssh-keygen -Y sign` or minisign) and verify the signature before restoring. Encryption alone doesn't prove origin, because anyone with the recipient's public key can encrypt a forged backup. `ops/restore.sh` treats every backup as untrusted input either way.
- **Retention:** keep at least the backup taken before each upgrade, and delete old ones deliberately.
- **Drills:** test restores regularly (section 5). An untested backup is a guess.

## 3. Online backup (not authoritative)

When you can't stop the app even briefly, you can take a database dump and a media copy while it runs:

```sh
docker exec <db container> sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > database.dump
docker run --rm --network none -v <media volume>:/data:ro --entrypoint sh <pinned postgres image> -c 'cd /data && tar -cf - .' > media.tar
```

**This pair may not match.** Uploads and deletions between the two commands leave records without files, or files without records. `ops/restore.sh` refuses it, because it has no valid manifest; don't hand-write one. Restore it by hand, then run `media:gc` as a dry run and review its report. Use the authoritative procedure for anything you rely on, especially before upgrades.

## 4. Scheduling

- **Manual by default.** COVALink has no backup scheduler.
- **Host scheduler (recommended for automation):** a cron entry or systemd timer **on the Docker host** that runs `ops/backup.sh`, followed by your encryption and off-host copy. Each run stops the app briefly.
- **Coolify scheduled task:** Coolify's scheduled tasks run a command *inside* one of the stack's containers, so a task in `db` can produce only an online, database-only dump, without media. Treat it as a supplement, never as the backup.
- **Nothing runs automatically before a deployment.** Run `ops/backup.sh` yourself before every upgrade.

## 5. Restore

**Restoring is destructive.** It replaces the target stack's database and media.

```sh
# 1. Validate only (checksums, manifest, target). Changes nothing.
ops/restore.sh --project <target> --from <backup directory>

# 2. Restore.
ops/restore.sh --project <target> --from <backup directory> --apply --confirm <target>

#    Only if the target already holds data you intend to discard:
ops/restore.sh --project <target> --from <backup directory> --apply --confirm <target> --replace-nonempty
```

**Preconditions.** The script refuses with exit code 3 unless all of these hold. The backup is treated as **untrusted input** and checked before Docker is called:
- **The files:** all four exist as regular files, not symbolic links.
- **`SHA256SUMS`:** exactly three lines naming `database.dump`, `media.tar` and `manifest.json` once each, and every hash matches.
- **`manifest.json`:** parsed against a fixed schema in the exact layout `backup.sh` writes. Every field appears exactly once, with no unknown fields; strings match their expected forms; counts and sizes are canonical non-negative integers within bounds; and its hashes and sizes match the archives. A refusal names the field, never its value, and no manifest value is ever evaluated by the shell.
- **The target** is a Compose project with `db`, `app` and `migrate` containers: `db` running, **`app` stopped**, and the media volume mounted at `/data/uploads`.
- **`--confirm`** repeats the target project name exactly.
- **The target is empty** (no tables and no media files), unless `--replace-nonempty` is also given.

**What it does after the checks:**
1. Recreates the database.
2. Restores the dump in a single transaction, stopping at the first error.
3. Replaces the media volume's contents with `media.tar`, and sets ownership to 1000:1000 (directories 0700, files 0600).
4. **Runs the migrator.** An older backup is brought forward to the image's schema. If the migrator fails, the script stops here with exit code 1 and doesn't start the app.
5. **Reconciles while the app is still stopped,** so no proxy can route to an inconsistent restore:
   - runs `media:gc` as a dry run in an isolated one-off container, and prints its report;
   - compares the media records with the stored files, key by key;
   - compares the migration level and the media counts with the manifest. More migrations than the backup is accepted; fewer is a discrepancy.
   - **Exit code 4:** any discrepancy. The app isn't started; investigate, then restore again.
6. **Only then starts `app`** and waits up to 180 seconds for readiness. **Exit code 0** means it's ready. **Exit code 1** means it isn't ready, or it exited; the script stops the app again, so a failed restore never stays up. It does the same if it's interrupted after starting the app.

### Restoring into a fresh stack (disaster recovery or a drill)

```sh
# Same compose.prod.yaml; a new project name gives new, empty volumes.
docker compose -p covalink-restore -f compose.prod.yaml --env-file <env> create    # db, migrate, app: created, not started
docker compose -p covalink-restore -f compose.prod.yaml --env-file <env> start db
ops/restore.sh --project covalink-restore --from <backup dir>                       # validate
ops/restore.sh --project covalink-restore --from <backup dir> --apply --confirm covalink-restore
```

Use the same `SERVICE_BASE64_64_AUTHSECRET` as the original, and an `APP_URL` for wherever the restored stack is served. `SERVICE_PASSWORD_64_POSTGRES` may differ for a fresh database, because roles aren't part of the dump. Supply `SERVICE_BASE64_64_SETUPTOKEN` too: `/setup` stays closed while the restored database exists.

### Restoring in place

1. Stop the app: `docker stop -t 60 <app container>`.
2. Restore with `--apply --confirm <project> --replace-nonempty`.
3. Deploy the **image the backup was taken with** (its commit is in the manifest), or a newer one. The migrator brings the database forward.

### After any restore

The script has already required media records and files to agree before starting the app. Through the domain, also check that `/api/ready` returns 200, that a known public profile renders with its images, and that an existing user can sign in. Then run the analytics purge, so events the retention period had removed don't come back:

```sh
docker exec <app container> node scripts/analytics-purge.mjs
```

Leftover temporary upload files can be removed once the app is running:

```sh
docker exec <app container> node scripts/media-gc.mjs --apply --min-age-hours=24
```

**If the restore exited with code 4,** the backup's database and media don't agree, and the app was left stopped. Prefer restoring another, older backup. To accept the backup as it is, review the reported records and files, start the app yourself (`docker start <app container>`), and clean up with `media:gc`. Records without a file then show as missing images.

## Rollback

- **Images:** deploy every version under an immutable tag (`covalink:<commit SHA>`), and keep at least the previous one.
- **App-only rollback:** redeploy the previous tag. That's safe **only when the database is compatible with the older code**: either no migration ran since that image, or the table below says the older image works with the newer schema.
- **Data rollback:** when the older code isn't compatible, restore the backup taken before the upgrade (section 5), then deploy the older tag.
- **Migrations are never rolled back automatically,** and there are no down migrations.
- **On Coolify:** for an app-only rollback, set `COVALINK_IMAGE_TAG` to the previous SHA and deploy the previous commit, then check `/api/ready`, the image label and a public profile. For a data rollback, stop the app with `docker stop -t 60 <app container>`, validate and then apply the restore from the operator checkout at the backup's commit, deploy that commit with `COVALINK_IMAGE_TAG` set to match, and run the checks in "After any restore".

**Migrations follow expand/contract:**
1. Add new columns and tables in one release, nullable or with defaults, so the previous release keeps working.
2. Switch the code over.
3. Remove or tighten old structures in a later release.

A migration that breaks the previous release says so in its file and in the table below, and that release must be rolled back by restoring a backup.

### Migration compatibility

| Migration | First release | Can the previous release run after it? |
|---|---|---|
| `0000_init` to `0004_analytics` | 0.1.0 | Not applicable: 0.1.0 is the first release. |

Each later migration is added to this table with its release, and whether the previous release can still run after it.
