#!/usr/bin/env bash
# One-off PROOF on YOUR dev stack: back it up (read-only pg_dump through `docker compose exec`), restore into a throwaway Postgres
# container, and compare the row count of every table in both databases. Writes only to a temp folder and the throwaway container.
#   deploy/tests/dev-backup-proof.sh          (the dev stack from docker-compose.yml must be running)
source "$(dirname "$0")/lib.sh"

ROOT="$(mktemp -d)"; CLEANUP_DIRS+=("$ROOT")
# The dev compose file wants this variable whenever it is read. `exec` never uses it, so a dummy value is enough (nothing is recreated).
export TRIAGEIQ_APP_DB_PASSWORD="${TRIAGEIQ_APP_DB_PASSWORD:-dummy-only-for-reading-the-compose-file}"
export COMPOSE_FILE="$REPO/docker-compose.yml"
export BACKUP_ROOT="$ROOT/backups"
unset TIQ_DB_EXEC

echo "back up the dev stack (docker compose exec db pg_dump -Fc, both databases)"
"$REPO/deploy/backup.sh"
DAY="$BACKUP_ROOT/$(date +%F)"
ls -l "$DAY" | sed 's/^/  /'

echo "a throwaway Postgres with the same superuser name the dev stack has"
DST="tiq-devproof-$RUN_ID"; CLEANUP_CONTAINERS+=("$DST")
docker run -d --name "$DST" -e POSTGRES_USER=triageiq -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB=triageiq \
  -e GATEWAY_DB_PASSWORD=throwaway -e TRIAGEIQ_APP_DB_PASSWORD=throwaway \
  -v "$REPO/db/init:/docker-entrypoint-initdb.d:ro" -v "$REPO/db/gateway-db.sql:/gateway-db.sql:ro" -v "$REPO/db/app-db.sql:/app-db.sql:ro" \
  "$PG_IMAGE" >/dev/null
wait_pg "$DST" triageiq throwaway triageiq

export TIQ_DB_EXEC="docker exec -i $DST"
unset COMPOSE_FILE
"$REPO/deploy/restore.sh" "$DAY/triageiq.dump" --yes
"$REPO/deploy/restore.sh" "$DAY/gateway.dump" --yes

counts() { # counts <exec-prefix...> -- <db>: "table=rows" for every user table
  local db="${@: -1}"; local -a ex=("${@:1:$#-1}")
  local tables t out=""
  tables="$("${ex[@]}" psql -U triageiq -d "$db" -tAc "select schemaname||'.'||tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1")"
  for t in $tables; do out+="$t=$("${ex[@]}" psql -U triageiq -d "$db" -tAc "select count(*) from $t") "; done
  echo "$out"
}
SRC_EX=(docker exec triageiq-db-1); DST_EX=(docker exec "$DST")
BEFORE_ROLE="$(counts "${DST_EX[@]}" triageiq)"
for db in triageiq gateway; do
  a="$(counts "${SRC_EX[@]}" "$db")"; b="$(counts "${DST_EX[@]}" "$db")"
  echo "  $db (dev stack):   $a"
  echo "  $db (restored):    $b"
  [ -n "$a" ] && expect_equal "row counts match for every table in $db" "$a" "$b"
done

echo "rehearsal of scripts/create_app_role.sh on the RESTORED COPY of your dev data (your real volume is not touched)"
docker exec "$DST" psql -v ON_ERROR_STOP=1 -U triageiq -d postgres -f /app-db.sql >/dev/null 2>&1 && pass "db/app-db.sql runs on your real data" || fail "db/app-db.sql on your data"
docker exec "$DST" psql -v ON_ERROR_STOP=1 -U triageiq -d postgres -f /app-db.sql >/dev/null 2>&1 && pass "and a second time" || fail "second run"
expect_equal "every table of the triageiq database is now owned by triageiq_app" "triageiq_app" "$(docker exec "$DST" psql -U triageiq -d triageiq -tAc "select string_agg(distinct pg_get_userbyid(relowner), ',') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','S','v','m')")"
expect_equal "row counts are unchanged by it" "$BEFORE_ROLE" "$(counts "${DST_EX[@]}" triageiq)"
IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DST")"
expect_equal "triageiq_app reads your tickets over the network with its own password" "24" "$(docker exec -e PGPASSWORD=throwaway "$DST" psql -h "$IP" -U triageiq_app -d triageiq -tAc 'select count(*) from tickets')"
expect_failure "triageiq_app cannot open the gateway database" docker exec -e PGPASSWORD=throwaway "$DST" psql -h "$IP" -U triageiq_app -d gateway -tAc 'select 1'
expect_failure "the gateway role cannot open the triageiq database" docker exec -e PGPASSWORD=throwaway "$DST" psql -h "$IP" -U gateway -d triageiq -tAc 'select 1'
if [ -n "${TIQ_PYTHON:-}" ]; then
  (cd "$REPO" && ANTHROPIC_API_KEY=x VOYAGE_API_KEY=x DATABASE_URL="postgresql://triageiq_app:throwaway@$IP:5432/triageiq" "$TIQ_PYTHON" -c "from app.migrations import run_migrations; run_migrations(); print('migrations ok as triageiq_app')") 2>&1 | tail -1 | sed 's/^/  /'
fi
finish
