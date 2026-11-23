#!/usr/bin/env bash
# Backs up BOTH databases (triageiq and gateway) with pg_dump -Fc into /var/backups/triageiq/<YYYY-MM-DD>/, chmod 600, and keeps
# the newest 7 days. Exits NON-ZERO on any failure (so systemd marks the run failed), and a failed run deletes nothing old.
#
#   ./backup.sh
#
# How it reaches the database: `docker compose exec` into the running db service, as the Postgres superuser (the container's own
# POSTGRES_USER, over the unix socket: no password on any command line). The dump streams out to a file on the host.
#
# Settings (environment, all optional):
#   BACKUP_ROOT     where backups go                    (default /var/backups/triageiq)
#   KEEP_DAYS       how many dated folders to keep      (default 7)
#   COMPOSE_FILE    the compose file to use             (default: docker-compose.prod.yml next to this script)
#   TIQ_DB_EXEC     the command that runs something in the db container, instead of `docker compose ... exec -T db`
#                   (the tests use `docker exec -i <container>`)
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/triageiq}"
KEEP_DAYS="${KEEP_DAYS:-7}"
DATABASES=(triageiq gateway)

if [ -n "${TIQ_DB_EXEC:-}" ]; then
  read -r -a DB_EXEC <<<"$TIQ_DB_EXEC"
else
  export TAG="${TAG:-backup}"   # the compose file insists on a TAG when it is read; `exec` does not use it
  DB_EXEC=(docker compose -f "${COMPOSE_FILE:-$HERE/docker-compose.prod.yml}" exec -T db)
fi

log() { echo "$(date '+%F %T') backup: $*"; }
die() { log "FAILED: $*" >&2; exit 1; }

case "$KEEP_DAYS" in ''|*[!0-9]*|0) die "KEEP_DAYS must be a whole number of at least 1" ;; esac

TODAY="$(date +%F)"
mkdir -p "$BACKUP_ROOT" && chmod 700 "$BACKUP_ROOT" || die "cannot create $BACKUP_ROOT"
WORK="$(mktemp -d "$BACKUP_ROOT/.running-XXXXXX")" || die "cannot create a work folder in $BACKUP_ROOT"
trap 'rm -rf "$WORK"' EXIT

"${DB_EXEC[@]}" true >/dev/null 2>&1 || die "cannot run commands in the db container (is the stack up?)"

for db in "${DATABASES[@]}"; do
  log "dumping $db"
  # pipefail makes a failing pg_dump fail the whole line, not just the redirection
  "${DB_EXEC[@]}" sh -c "pg_dump -Fc -U \"\$POSTGRES_USER\" -d $db" > "$WORK/$db.dump" || die "pg_dump of $db failed"
  [ -s "$WORK/$db.dump" ] || die "the dump of $db is empty"
  # An archive that pg_restore cannot read is worth nothing: check it NOW, not on the day it is needed.
  "${DB_EXEC[@]}" pg_restore --list < "$WORK/$db.dump" >/dev/null || die "the dump of $db cannot be read back by pg_restore"
  chmod 600 "$WORK/$db.dump"
  log "$db ok ($(stat -c %s "$WORK/$db.dump") bytes)"
done

# Everything succeeded: publish the folder (replacing an earlier run of the same day), then trim old days.
DEST="$BACKUP_ROOT/$TODAY"
mkdir -p "$DEST"; chmod 700 "$DEST"
for db in "${DATABASES[@]}"; do mv -f "$WORK/$db.dump" "$DEST/$db.dump"; done

# Keep the newest $KEEP_DAYS dated folders (YYYY-MM-DD names sort by date). Only folders with exactly that name are ever touched.
mapfile -t OLD < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}' -printf '%f\n' | sort -r | tail -n +"$((KEEP_DAYS + 1))")
for old in "${OLD[@]:-}"; do
  [ -n "$old" ] || continue
  rm -rf -- "${BACKUP_ROOT:?}/$old"
  log "removed old backup $old"
done

log "done: $DEST"
