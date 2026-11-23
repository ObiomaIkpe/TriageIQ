#!/usr/bin/env bash
# Restores ONE database from a dump made by backup.sh. It REPLACES what is in that database.
#
#   ./restore.sh /var/backups/triageiq/2026-11-23/triageiq.dump            (asks you to type the database name)
#   ./restore.sh /var/backups/triageiq/2026-11-23/gateway.dump --yes        (no question)
#
# The database name is taken from the file name (triageiq.dump or gateway.dump); only those two are accepted.
# Stop the services that use the database first (the script refuses to run while they are up):
#   triageiq database -> stop app and gateway;  gateway database -> stop gateway.
# The restore runs as the Postgres superuser in ONE transaction: if anything fails, nothing is changed. Ownership comes from the
# dump (triageiq_app / gateway), so the roles must exist (they do: the db init scripts created them).
#
# Settings: COMPOSE_FILE and TIQ_DB_EXEC as in backup.sh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DUMP="${1:-}"; YES=0
[ "${2:-}" = "--yes" ] && YES=1
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "usage: $0 <path to triageiq.dump or gateway.dump> [--yes]" >&2; exit 2; }

DB="$(basename "$DUMP" .dump)"
case "$DB" in triageiq|gateway) ;; *) echo "the file must be named triageiq.dump or gateway.dump (got: $(basename "$DUMP"))" >&2; exit 2 ;; esac

if [ -n "${TIQ_DB_EXEC:-}" ]; then
  read -r -a DB_EXEC <<<"$TIQ_DB_EXEC"; COMPOSE=()
else
  export TAG="${TAG:-restore}"
  COMPOSE=(docker compose -f "${COMPOSE_FILE:-$HERE/docker-compose.prod.yml}")
  DB_EXEC=("${COMPOSE[@]}" exec -T db)
fi

# 1. The services that use the database must be stopped.
if [ "${#COMPOSE[@]}" -gt 0 ]; then
  users=(gateway); [ "$DB" = "triageiq" ] && users=(app gateway)
  running="$("${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -Fxf <(printf '%s\n' "${users[@]}") || true)"
  if [ -n "$running" ]; then
    echo "Refusing: still running: $(echo "$running" | tr "\n" " "). Stop them first:  docker compose -f ${COMPOSE_FILE:-docker-compose.prod.yml} stop ${users[*]}" >&2
    exit 3
  fi
fi

# 2. The dump must be readable BEFORE anything is dropped, and must be a dump of THIS database (not the other one renamed).
LISTING="$("${DB_EXEC[@]}" pg_restore --list < "$DUMP" 2>/dev/null)" || { echo "Refusing: $DUMP is not a readable pg_dump archive. Nothing was changed." >&2; exit 4; }
printf '%s\n' "$LISTING" | grep -Eq "^;[[:space:]]+dbname:[[:space:]]+$DB\$" || { echo "Refusing: $DUMP is a dump of another database, not of \"$DB\". Nothing was changed." >&2; exit 4; }

# 3. Confirmation.
if [ "$YES" = 0 ]; then
  [ -t 0 ] || { echo "Refusing: not a terminal, and no --yes given. Nothing was changed." >&2; exit 5; }
  echo "This REPLACES everything in the \"$DB\" database with the contents of $DUMP."
  read -r -p "Type the database name ($DB) to go on: " answer
  [ "$answer" = "$DB" ] || { echo "Not confirmed. Nothing was changed." >&2; exit 5; }
fi

# 4. Restore EXACTLY what the dump holds: the public schema (where everything lives) is dropped and rebuilt from the dump, so a table
#    created after the backup is gone too (pg_restore --clean alone would leave it). It is ONE transaction: the COMMIT is sent only if
#    pg_restore finished, and any SQL error stops psql, so a failed restore changes nothing.
echo "$(date '+%F %T') restore: restoring $DB from $DUMP"
"${DB_EXEC[@]}" bash -c "set -o pipefail; { echo 'BEGIN;'; echo 'DROP SCHEMA IF EXISTS public CASCADE;'; echo 'CREATE SCHEMA public AUTHORIZATION pg_database_owner;'; echo 'GRANT USAGE ON SCHEMA public TO PUBLIC;'; pg_restore -f - && echo 'COMMIT;'; } | psql -q -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d $DB" < "$DUMP"
echo "$(date '+%F %T') restore: done. Start the services again:  docker compose -f ${COMPOSE_FILE:-docker-compose.prod.yml} up -d"
