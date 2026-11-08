#!/usr/bin/env bash
# COVALink authoritative backup: PostgreSQL and uploaded media as one
# consistent pair. See docs/BACKUP_RESTORE.md.
#
#   ops/backup.sh --project <compose-project> --out <directory>
#
# 1. stops the app (graceful, 60 s), keeping PostgreSQL running;
# 2. writes database.dump (pg_dump -Fc) and media.tar (the media volume);
# 3. writes manifest.json (time, image, migration level, media row count,
#    managed-file count, archive checksums) and SHA256SUMS;
# 4. starts the app again and waits for readiness.
# The app is restarted on every exit path if it was running. Output files are
# 0600 in a new 0700 directory. No environment files or Compose secrets are
# included. Backups contain password hashes, sessions and personal data:
# encrypt them and copy them off the host (docs/BACKUP_RESTORE.md).
set -euo pipefail
umask 077
SCRIPT=backup
# shellcheck source=ops/lib.sh
source "$(dirname "$0")/lib.sh"

project="" out=""
while (( $# )); do
  case "$1" in
    --project) project="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
[[ -n "$project" && -n "$out" ]] || die "usage: ops/backup.sh --project <compose-project> --out <directory>" 2
require_project_name "$project"

db=$(container_for "$project" db)
app=$(container_for "$project" app)
[[ -n "$db" && -n "$app" ]] || die "no db/app containers found for Compose project '$project'"
is_running "$db" || die "the db container must be running"
volume=$(media_volume "$app")
[[ "$volume" == volume:* ]] || die "the app has no named volume at $MEDIA_MOUNT"
volume=${volume#volume:}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$out"
dest="$out/covalink-$project-$stamp"
mkdir "$dest"
chmod 700 "$dest"

app_was_running=false
is_running "$app" && app_was_running=true
finish() {
  local status=$?
  if [[ "$app_was_running" == true ]] && ! is_running "$app"; then
    log "starting the app again"
    docker start "$app" >/dev/null || true
  fi
  if (( status != 0 )); then
    printf '[backup] FAILED (exit %s). The incomplete backup in %s is NOT valid.\n' "$status" "$dest" >&2
  fi
}
trap finish EXIT

if [[ "$app_was_running" == true ]]; then
  log "stopping the app (graceful, up to 60 s) for a consistent backup"
  docker stop -t 60 "$app" >/dev/null
fi

log "dumping PostgreSQL"
docker exec "$db" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$dest/database.dump"
migrations=$(sql "$db" 'select count(*) from drizzle.__drizzle_migrations')
latest=$(sql "$db" "select coalesce(max(created_at)::text, '') from drizzle.__drizzle_migrations")
media_rows=$(sql "$db" 'select count(*) from media_assets')

log "archiving the media volume"
docker run --rm --network none -v "$volume:/data:ro" --entrypoint sh "$HELPER_IMAGE" -c 'cd /data && tar -cf - .' > "$dest/media.tar"
managed_files=$(managed_file_count "$volume")

image_ref=$(docker inspect -f '{{.Config.Image}}' "$app")
image_id=$(docker inspect -f '{{.Image}}' "$app")
revision=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$app")
db_sha=$(sha256_of "$dest/database.dump")
media_sha=$(sha256_of "$dest/media.tar")

cat > "$dest/manifest.json" <<EOF
{
  "format": "$BACKUP_FORMAT",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "project": "$project",
  "consistency": "app-stopped",
  "imageReference": "$image_ref",
  "imageId": "$image_id",
  "gitRevision": "$revision",
  "migrationCount": $migrations,
  "latestMigrationCreatedAt": "$latest",
  "mediaRows": $media_rows,
  "managedFiles": $managed_files,
  "databaseFile": "database.dump",
  "databaseBytes": $(bytes_of "$dest/database.dump"),
  "databaseSha256": "$db_sha",
  "mediaFile": "media.tar",
  "mediaBytes": $(bytes_of "$dest/media.tar"),
  "mediaSha256": "$media_sha"
}
EOF
(cd "$dest" && sha256sum database.dump media.tar manifest.json > SHA256SUMS)
chmod 600 "$dest"/*

if [[ "$app_was_running" == true ]]; then
  log "starting the app"
  docker start "$app" >/dev/null
  wait_ready "$app" 180 || die "the app did not become ready within 180 s after the backup (the backup itself is complete)"
  log "the app is ready"
fi

log "backup complete: $dest"
log "migrations=$migrations mediaRows=$media_rows managedFiles=$managed_files revision=$revision"
