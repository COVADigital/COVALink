# Shared helpers for ops/backup.sh and ops/restore.sh (sourced, not run).
# Containers are found by their Compose labels, so the scripts work for any
# project name (Coolify's generated one or a plain `docker compose -p NAME`).

# Git Bash on Windows would otherwise rewrite container paths like /data.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# Helper image for archive work: the stack's own pinned PostgreSQL image
# (busybox tar/find/sha256sum), so no extra image is pulled or trusted.
HELPER_IMAGE="postgres:17.11-alpine3.24@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"
MEDIA_MOUNT="/data/uploads"
BACKUP_FORMAT="covalink-backup/1"

log() { printf '[%s] %s\n' "$SCRIPT" "$*"; }
die() { printf '[%s] ERROR: %s\n' "$SCRIPT" "$1" >&2; exit "${2:-1}"; }

require_project_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "--project must be a Compose project name (lowercase letters, digits, - and _)"
}

# container_for <project> <service>: the container ID of that service, or empty.
container_for() {
  docker ps -aq \
    --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.service=$2" | head -n 1
}

is_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1")" == "true" ]]; }

# media_volume <app container>: the named volume mounted at /data/uploads.
media_volume() {
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "'"$MEDIA_MOUNT"'"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$1"
}

# sql <db container> <statement>: one unaligned value, run as the database owner.
sql() {
  docker exec "$1" sh -c 'psql -X -A -t -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$0"' "$2"
}

# media_keys <volume>: the storage keys of the stored images, sorted (C
# locale). A key counts only as a regular file at {k[0:2]}/{k[2:4]}/{k}, the
# same rule media:gc applies (features/media/layout.mjs); symlinks never count.
media_keys() {
  local path key re='^/data/([0-9a-f]{2})/([0-9a-f]{2})/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp)$'
  docker run --rm --network none -v "$1:/data:ro" --entrypoint find "$HELPER_IMAGE" /data -mindepth 3 -maxdepth 3 -type f |
    while IFS= read -r path; do
      if [[ "$path" =~ $re ]]; then
        key=${BASH_REMATCH[3]}
        if [[ "${key:0:2}" == "${BASH_REMATCH[1]}" && "${key:2:2}" == "${BASH_REMATCH[2]}" ]]; then printf '%s\n' "$key"; fi
      fi
    done | LC_ALL=C sort
}

# managed_file_count <volume>: the number of stored images (see media_keys).
managed_file_count() {
  local keys
  keys=$(media_keys "$1") || return 1
  if [[ -z "$keys" ]]; then echo 0; else printf '%s\n' "$keys" | wc -l | tr -d ' '; fi
}

# gc_dry_run <migrate container> <volume>: media:gc as a dry run in a one-off
# container of the migrator's image, on the migrator's network only, with the
# media volume read-only. Nothing is published and nothing routes traffic to
# it, so it runs while the app is still stopped. DATABASE_URL is taken from the
# migrator's configuration and passed by name, never on a command line.
gc_dry_run() {
  local image network url
  image=$(docker inspect -f '{{.Image}}' "$1")
  network=$(docker inspect -f '{{range $name, $net := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$1" | head -n 1)
  url=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" | sed -n 's/^DATABASE_URL=//p' | head -n 1)
  [[ -n "$image" && -n "$network" && -n "$url" ]] || { log "cannot find the migrator's image, network or DATABASE_URL"; return 1; }
  DATABASE_URL="$url" docker run --rm --network "$network" --read-only --ipc none --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 64 -e DATABASE_URL -v "$2:/data/uploads:ro" \
    --entrypoint node "$image" scripts/media-gc.mjs
}

# wait_ready <app container> <seconds>: until /api/ready answers 200 inside the
# container. Fails at once if the app exits or is restarted meanwhile (e.g. the
# start-up validator's exit 78 under `restart: unless-stopped`).
wait_ready() {
  local deadline=$((SECONDS + $2)) restarts state
  restarts=$(docker inspect -f '{{.RestartCount}}' "$1")
  while (( SECONDS < deadline )); do
    if docker exec "$1" node scripts/healthcheck.mjs ready >/dev/null 2>&1; then return 0; fi
    state=$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$1")
    if [[ "$state" != "running $restarts" && "$state" != "created $restarts" ]]; then
      log "the app exited or restarted while starting (state: $state)"
      return 1
    fi
    sleep 2
  done
  return 1
}

sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
bytes_of() { wc -c < "$1" | tr -d ' '; }

# is_uint <value> <max digits>: a canonical non-negative decimal integer (no
# sign, leading zero, fraction or exponent) of at most that many digits.
is_uint() { [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]] && (( ${#1} <= $2 )); }

# uint_lt <a> <b>: a < b for two values that passed is_uint, compared as
# strings (length, then digits), so no value is ever evaluated as arithmetic.
uint_lt() {
  if (( ${#1} != ${#2} )); then (( ${#1} < ${#2} )); else [[ "$1" < "$2" ]]; fi
}

# ---- backup files are untrusted input ------------------------------------------
# Whoever can write a backup directory can also recompute its checksums, so
# SHA256SUMS and the manifest's hashes detect corruption, not tampering. Both
# files are parsed against a fixed schema; their values are only ever compared
# as strings or printed, and never reach eval, arithmetic or a command line.

# plain_text <file> <max bytes>: a regular file (not a symlink) of printable
# ASCII and newlines only, no larger than the limit.
plain_text() {
  local size
  [[ -f "$1" && ! -L "$1" ]] || return 1
  size=$(bytes_of "$1")
  is_uint "$size" 9 && ! uint_lt "$2" "$size" || return 1
  [[ "$(LC_ALL=C tr -d '\n\040-\176' < "$1" | wc -c | tr -d ' ')" == 0 ]]
}

# verify_checksums <backup dir>: SHA256SUMS lists exactly database.dump,
# media.tar and manifest.json, once each, and every file matches. Sets
# CHECKSUM[name] to the computed hash. The listed names are only compared
# with the fixed names, never used as paths.
declare -A CHECKSUM=()
verify_checksums() {
  # GNU format: "<hash>  <name>" (text mode) or "<hash> *<name>" (binary mode, Git Bash's default).
  local file="$1/SHA256SUMS" line name computed re='^([0-9a-f]{64}) [ *](database\.dump|media\.tar|manifest\.json)$'
  local -a lines
  local -A listed=()
  plain_text "$file" 1024 || die "SHA256SUMS is not a small plain-text file" 3
  mapfile -t lines < "$file"
  (( ${#lines[@]} == 3 )) || die "SHA256SUMS must list exactly database.dump, media.tar and manifest.json" 3
  for line in "${lines[@]}"; do
    [[ "$line" =~ $re ]] || die "SHA256SUMS has a malformed line" 3
    [[ -z "${listed[${BASH_REMATCH[2]}]+set}" ]] || die "SHA256SUMS lists ${BASH_REMATCH[2]} twice" 3
    listed[${BASH_REMATCH[2]}]=${BASH_REMATCH[1]}
  done
  for name in database.dump media.tar manifest.json; do
    computed=$(sha256_of "$1/$name")
    [[ "$computed" == "${listed[$name]}" ]] || die "checksum verification failed: $name is damaged or was modified" 3
    CHECKSUM[$name]=$computed
  done
}

# The manifest schema (exactly what backup.sh writes). String fields: the
# pattern the value must match in full. Integer fields: the maximum number of
# digits. Every field is required exactly once; any other field is refused.
declare -A MANIFEST_STRINGS=(
  [format]='^covalink-backup/1$'
  [createdAt]='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
  [project]='^[a-z0-9][a-z0-9_-]{0,62}$'
  [consistency]='^app-stopped$'
  [imageReference]='^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$'
  [imageId]='^sha256:[0-9a-f]{64}$'
  [gitRevision]='^[A-Za-z0-9._-]{0,128}$'
  [latestMigrationCreatedAt]='^([0-9]{1,16})?$'
  [databaseFile]='^database\.dump$'
  [databaseSha256]='^[0-9a-f]{64}$'
  [mediaFile]='^media\.tar$'
  [mediaSha256]='^[0-9a-f]{64}$'
)
declare -A MANIFEST_INTEGERS=(
  [migrationCount]=4
  [mediaRows]=9
  [managedFiles]=9
  [databaseBytes]=13
  [mediaBytes]=13
)

# read_manifest <file>: parses the manifest into MANIFEST[key], or refuses
# (exit 3) naming only the field, never its value. The accepted grammar is the
# canonical layout backup.sh writes: "{", one `  "key": value` line per field
# with a comma on every line but the last, "}". Strings may not contain quotes
# or backslashes, so every accepted file is valid JSON with these values.
declare -A MANIFEST=()
read_manifest() {
  local i n line key raw value last
  local pair_re='^  "([A-Za-z0-9]{1,40})": (.*)$' string_re='^"([^"\\]*)"$'
  local -a lines
  local -A seen=()
  plain_text "$1" 8192 || die "manifest.json is invalid: not a small plain-text file" 3
  mapfile -t lines < "$1"
  n=${#lines[@]}
  (( n >= 3 && n <= 64 )) && [[ "${lines[0]}" == "{" && "${lines[n-1]}" == "}" ]] || die "manifest.json is invalid: not a JSON object in the canonical layout" 3
  for (( i = 1; i < n - 1; i++ )); do
    line=${lines[i]}
    last=$(( i == n - 2 ))
    if (( last )); then
      [[ "$line" != *, ]] || die "manifest.json is invalid: trailing comma on line $(( i + 1 ))" 3
    else
      [[ "$line" == *, ]] || die "manifest.json is invalid: missing comma on line $(( i + 1 ))" 3
      line=${line%,}
    fi
    [[ "$line" =~ $pair_re ]] || die "manifest.json is invalid: line $(( i + 1 )) is not a \"field\": value pair" 3
    key=${BASH_REMATCH[1]} raw=${BASH_REMATCH[2]}
    [[ -z "${seen[$key]+set}" ]] || die "manifest.json is invalid: duplicate field $key" 3
    seen[$key]=1
    if [[ -n "${MANIFEST_STRINGS[$key]+set}" ]]; then
      [[ "$raw" =~ $string_re ]] || die "manifest.json is invalid: $key must be a string" 3
      value=${BASH_REMATCH[1]}
      [[ "$value" =~ ${MANIFEST_STRINGS[$key]} ]] || die "manifest.json is invalid: $key has an unexpected value" 3
      MANIFEST[$key]=$value
    elif [[ -n "${MANIFEST_INTEGERS[$key]+set}" ]]; then
      is_uint "$raw" "${MANIFEST_INTEGERS[$key]}" || die "manifest.json is invalid: $key must be a non-negative integer of at most ${MANIFEST_INTEGERS[$key]} digits" 3
      MANIFEST[$key]=$raw
    else
      die "manifest.json is invalid: unknown field $key" 3
    fi
  done
  for key in "${!MANIFEST_STRINGS[@]}" "${!MANIFEST_INTEGERS[@]}"; do
    [[ -n "${seen[$key]+set}" ]] || die "manifest.json is invalid: missing field $key" 3
  done
}
