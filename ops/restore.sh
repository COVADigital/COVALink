#!/usr/bin/env bash
# COVALink restore: replaces a stack's PostgreSQL database and media
# volume with a backup made by ops/backup.sh. DESTRUCTIVE. See
# docs/BACKUP_RESTORE.md.
#
#   ops/restore.sh --project <compose-project> --from <backup directory>
#       validates only (checksums, manifest, target); changes nothing
#   ops/restore.sh --project <p> --from <dir> --apply --confirm <p> [--replace-nonempty]
#       restores; --replace-nonempty is also required if the target database
#       or media volume already holds data
#
# Requires: the target's db container running, its app container stopped, and
# its migrate container present (`docker compose create` makes all three).
# The backup is untrusted input: SHA256SUMS and manifest.json are parsed
# against a fixed schema before anything is changed. After restoring it runs
# the migrator, then reconciles WHILE THE APP IS STILL STOPPED (media keys vs
# rows, a media:gc dry run, manifest counts), and only then starts the app and
# waits for readiness. Any failure leaves the app stopped.
# Exit codes: 0 ok, 1 error, 2 usage, 3 refused (invalid backup / target not
# empty / app running / checks failed), 4 restored but inconsistent with the
# manifest (the app was not started).
set -euo pipefail
umask 077
SCRIPT=restore
# shellcheck source=ops/lib.sh
source "$(dirname "$0")/lib.sh"

project="" from="" apply=false confirm="" replace=false
while (( $# )); do
  case "$1" in
    --project) project="${2:-}"; shift 2 ;;
    --from) from="${2:-}"; shift 2 ;;
    --apply) apply=true; shift ;;
    --confirm) confirm="${2:-}"; shift 2 ;;
    --replace-nonempty) replace=true; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
[[ -n "$project" && -n "$from" ]] || die "usage: ops/restore.sh --project <compose-project> --from <backup directory> [--apply --confirm <project>]" 2
require_project_name "$project"

# ---- 1. the backup: files, checksums, manifest (no Docker, nothing changed) ------
for f in manifest.json database.dump media.tar SHA256SUMS; do
  [[ -f "$from/$f" && ! -L "$from/$f" ]] || die "backup is missing $f (or it is not a regular file)" 3
done
verify_checksums "$from"
read_manifest "$from/manifest.json"
[[ "${MANIFEST[databaseSha256]}" == "${CHECKSUM[database.dump]}" ]] || die "database.dump does not match the manifest" 3
[[ "${MANIFEST[mediaSha256]}" == "${CHECKSUM[media.tar]}" ]] || die "media.tar does not match the manifest" 3
[[ "${MANIFEST[databaseBytes]}" == "$(bytes_of "$from/database.dump")" ]] || die "database.dump size does not match the manifest" 3
[[ "${MANIFEST[mediaBytes]}" == "$(bytes_of "$from/media.tar")" ]] || die "media.tar size does not match the manifest" 3
want_migrations=${MANIFEST[migrationCount]}
want_rows=${MANIFEST[mediaRows]}
want_files=${MANIFEST[managedFiles]}
log "backup verified: project ${MANIFEST[project]}, created ${MANIFEST[createdAt]}, revision ${MANIFEST[gitRevision]:-unknown}"
log "backup holds: migrations=$want_migrations mediaRows=$want_rows managedFiles=$want_files"
log "note: checksums detect corruption, not tampering; restore only backups from storage you control"

# ---- 2. the target ---------------------------------------------------------------
db=$(container_for "$project" db)
app=$(container_for "$project" app)
migrate=$(container_for "$project" migrate)
[[ -n "$db" && -n "$app" && -n "$migrate" ]] || die "target project '$project' needs db, app and migrate containers (run: docker compose ... create)" 3
is_running "$db" || die "the target db container must be running" 3
is_running "$app" && die "the target app must be stopped first (docker stop -t 60 <app container>)" 3
volume=$(media_volume "$app")
[[ "$volume" == volume:* ]] || die "the target app has no named volume at $MEDIA_MOUNT" 3
volume=${volume#volume:}

db_objects=$(sql "$db" "select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')")
media_entries=$(docker run --rm --network none -v "$volume:/data:ro" --entrypoint sh "$HELPER_IMAGE" -c 'find /data -mindepth 1 | wc -l' | tr -d ' ')
is_uint "$db_objects" 9 && is_uint "$media_entries" 12 || die "could not inspect the target" 1
log "target: project $project, database tables=$db_objects, media volume $volume entries=$media_entries"
nonempty=false
[[ "$db_objects" != 0 || "$media_entries" != 0 ]] && nonempty=true

if [[ "$apply" != true ]]; then
  log "validation only: nothing was changed. Re-run with --apply --confirm $project to restore."
  [[ "$nonempty" == true ]] && log "note: the target is NOT empty; --replace-nonempty would also be required"
  exit 0
fi
[[ "$confirm" == "$project" ]] || die "--confirm must repeat the target project name ($project)" 3
if [[ "$nonempty" == true && "$replace" != true ]]; then
  die "the target already holds data (tables=$db_objects, media entries=$media_entries); refusing without --replace-nonempty" 3
fi

# From here on the app may only be started by step 5. If the script stops for
# any reason after starting it, it is stopped again.
app_started=false
leave_app_stopped() {
  local status=$?
  if (( status != 0 )) && [[ "$app_started" == true ]]; then
    log "stopping the app: the restore did not complete"
    docker stop -t 60 "$app" >/dev/null || true
  fi
  if (( status != 0 )); then
    printf '[restore] FAILED (exit %s). The app is stopped; the target is NOT a valid restore.\n' "$status" >&2
  fi
}
trap leave_app_stopped EXIT
trap 'exit 130' INT TERM

# ---- 3. restore (the app is stopped) ---------------------------------------------
log "recreating the database"
docker exec "$db" sh -c 'dropdb --if-exists --force -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"'
log "restoring PostgreSQL (single transaction)"
docker exec -i "$db" sh -c 'pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$from/database.dump"

log "restoring the media volume"
docker run --rm -i --network none -v "$volume:/data" --entrypoint sh "$HELPER_IMAGE" -c \
  'find /data -mindepth 1 -delete && tar -xf - -C /data && chown -R 1000:1000 /data && find /data -type d -exec chmod 700 {} + && find /data -type f -exec chmod 600 {} +' \
  < "$from/media.tar"

log "running the migrator"
docker start -a "$migrate" || die "the migrator failed after the restore; the app was not started" 1

# ---- 4. reconcile (the app is still stopped) ---------------------------------------
log "media:gc dry run (one-off container on the migrator's network; the app is stopped):"
gc_report=$(gc_dry_run "$migrate" "$volume") || die "the media:gc dry run failed; the app was not started" 1
printf '%s\n' "$gc_report" | sed 's/^/    /'

got_migrations=$(sql "$db" 'select count(*) from drizzle.__drizzle_migrations')
got_rows=$(sql "$db" 'select count(*) from media_assets')
row_keys=$(sql "$db" 'select storage_key from media_assets' | LC_ALL=C sort)
file_keys=$(media_keys "$volume")
got_files=0
[[ -z "$file_keys" ]] || got_files=$(printf '%s\n' "$file_keys" | wc -l | tr -d ' ')
for v in "$got_migrations" "$got_rows" "$got_files"; do
  is_uint "$v" 12 || die "could not count the restored data" 1
done

status=0
if uint_lt "$got_migrations" "$want_migrations"; then
  log "DISCREPANCY: migrations $got_migrations < backup $want_migrations"; status=4
elif uint_lt "$want_migrations" "$got_migrations"; then
  log "migrated forward: $want_migrations -> $got_migrations migrations (newer image)"
fi
[[ "$got_rows" == "$want_rows" ]] || { log "DISCREPANCY: media rows $got_rows, backup $want_rows"; status=4; }
[[ "$got_files" == "$want_files" ]] || { log "DISCREPANCY: managed files $got_files, backup $want_files"; status=4; }
if [[ "$row_keys" != "$file_keys" ]]; then
  rows_without_file=$(LC_ALL=C comm -23 <(printf '%s\n' "$row_keys") <(printf '%s\n' "$file_keys") | grep -c . || true)
  files_without_row=$(LC_ALL=C comm -13 <(printf '%s\n' "$row_keys") <(printf '%s\n' "$file_keys") | grep -c . || true)
  log "DISCREPANCY: media keys differ: $rows_without_file row(s) without a file, $files_without_row file(s) without a row"
  status=4
fi
log "restored: migrations=$got_migrations mediaRows=$got_rows managedFiles=$got_files"
if (( status != 0 )); then
  log "the restored data is inconsistent with the backup; the app was NOT started. Investigate, then restore again."
  exit "$status"
fi
log "counts match the manifest and every media row has exactly its file"

# ---- 5. start the app ---------------------------------------------------------------
log "starting the app"
app_started=true
docker start "$app" >/dev/null
wait_ready "$app" 180 || die "the app did not become ready within 180 s" 1
log "restore complete; the app is ready"
