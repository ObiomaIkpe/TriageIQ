#!/usr/bin/env bash
# PROOF that a backup can be restored: back up a throwaway source database (both databases), restore into a SECOND throwaway
# Postgres, and compare the row count of every table. Also: retention, permissions, failure handling, restore refusals.
# Nothing of yours is touched (throwaway containers, a temp folder).
source "$(dirname "$0")/lib.sh"

ADMIN=tiq_admin ADMINPW=admin-pw-$RUN_ID APPPW=app-pw-$RUN_ID GWPW=gw-pw-$RUN_ID
BACKUP="$REPO/deploy/backup.sh" RESTORE="$REPO/deploy/restore.sh"
ROOT="$(mktemp -d)"; CLEANUP_DIRS+=("$ROOT")

start_pg() { # start_pg <name>: a fresh Postgres with the production init scripts
  CLEANUP_CONTAINERS+=("$1")
  docker run -d --name "$1" -e POSTGRES_USER=$ADMIN -e POSTGRES_PASSWORD=$ADMINPW -e POSTGRES_DB=triageiq \
    -e GATEWAY_DB_PASSWORD=$GWPW -e TRIAGEIQ_APP_DB_PASSWORD=$APPPW \
    -v "$REPO/deploy/db/init:/docker-entrypoint-initdb.d:ro" -v "$REPO/deploy/db/gateway-db.sql:/gateway-db.sql:ro" -v "$REPO/deploy/db/app-db.sql:/app-db.sql:ro" \
    "$PG_IMAGE" >/dev/null
  wait_pg "$1" $ADMIN $ADMINPW triageiq
}
SRC="tiq-bk-src-$RUN_ID"; DST="tiq-bk-dst-$RUN_ID"
start_pg "$SRC"; start_pg "$DST"
sql() { psql_as "$1" $ADMIN "$ADMINPW" "$2" "$3"; }

echo "sample data in the source (both databases, vectors, unicode, a sequence, a view)"
docker exec -i -e PGPASSWORD="$APPPW" "$SRC" psql -h "$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$SRC")" -v ON_ERROR_STOP=1 -U triageiq_app -d triageiq -q <<'SQL'
create table kb_documents(id serial primary key, topic text unique, content text, embedding vector(3));
create table tickets(id uuid primary key default gen_random_uuid(), subject text, body text, ai_usage jsonb, ai_cost_usd double precision);
create table alembic_version(version_num text primary key);
create view open_tickets as select * from tickets where ai_cost_usd is not null;
insert into kb_documents(topic, content, embedding) select 'topic '||g, 'Ọbiọma Ụzọ ✓ '||g, ('['||g||',2,3]')::vector from generate_series(1,12) g;
insert into tickets(subject, body, ai_usage, ai_cost_usd) select 's'||g, repeat('body ', 50), '{"total_tokens": 100}', g/1000.0 from generate_series(1,250) g;
insert into alembic_version values ('0005');
SQL
docker exec -i -e PGPASSWORD="$GWPW" "$SRC" psql -h "$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$SRC")" -v ON_ERROR_STOP=1 -U gateway -d gateway -q <<'SQL'
create table users(id serial primary key, email text unique, name text);
create table reply_deliveries(id serial primary key, ticket_id uuid, status text);
insert into users(email, name) select 'u'||g||'@example.com', 'User '||g from generate_series(1,7) g;
insert into reply_deliveries(ticket_id, status) select gen_random_uuid(), 'sent' from generate_series(1,40);
SQL

counts() { # counts <container> <db>: "table=rows" for every table, sorted
  local db="$2" tables t out=""
  tables="$(sql "$1" "$db" "select tablename from pg_tables where schemaname='public' order by 1")"
  for t in $tables; do out+="$t=$(sql "$1" "$db" "select count(*) from \"$t\"") "; done
  echo "$out"
}
SRC_APP="$(counts "$SRC" triageiq)"; SRC_GW="$(counts "$SRC" gateway)"
echo "  source triageiq: $SRC_APP"; echo "  source gateway:  $SRC_GW"
# The comparison below would pass on two EMPTY databases: make sure the source really has the data.
expect_equal "the source has the sample rows" "alembic_version=1 kb_documents=12 tickets=250 |reply_deliveries=40 users=7 " "$SRC_APP|$SRC_GW"

export BACKUP_ROOT="$ROOT/backups" KEEP_DAYS=7
export TIQ_DB_EXEC="docker exec -i $SRC"

echo "backup"
# 9 fake old days (plus one folder that must NEVER be touched: it is not a date)
mkdir -p "$BACKUP_ROOT"
for d in 2026-01-01 2026-01-02 2026-01-03 2026-01-04 2026-01-05 2026-01-06 2026-01-07 2026-01-08 2026-01-09; do mkdir -p "$BACKUP_ROOT/$d"; echo old > "$BACKUP_ROOT/$d/triageiq.dump"; done
mkdir -p "$BACKUP_ROOT/keep-me-not-a-date"
expect_success "backup.sh succeeds" "$BACKUP"
DAY="$BACKUP_ROOT/$(date +%F)"
expect_success "a dump of triageiq exists" test -s "$DAY/triageiq.dump"
expect_success "a dump of gateway exists" test -s "$DAY/gateway.dump"
expect_equal "dumps are chmod 600" "600 600" "$(stat -c %a "$DAY/triageiq.dump") $(stat -c %a "$DAY/gateway.dump")"
expect_equal "the dated folder is chmod 700" "700" "$(stat -c %a "$DAY")"
expect_equal "the backup root is chmod 700" "700" "$(stat -c %a "$BACKUP_ROOT")"
expect_equal "only the newest 7 dated folders are kept" "7" "$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' | wc -l | tr -d ' ')"
expect_success "the oldest were removed (2026-01-01)" test ! -e "$BACKUP_ROOT/2026-01-01"
expect_success "a folder that is not a date is never touched" test -d "$BACKUP_ROOT/keep-me-not-a-date"
expect_equal "no work folder is left behind" "0" "$(find "$BACKUP_ROOT" -maxdepth 1 -name '.running-*' | wc -l | tr -d ' ')"
expect_success "running it again the same day works (replaces that day)" "$BACKUP"

echo "a FAILING backup exits non-zero and deletes nothing"
BEFORE="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 | sort | md5sum)"
TIQ_DB_EXEC="docker exec -i no-such-container-$RUN_ID" expect_failure "backup.sh fails when the database cannot be reached" "$BACKUP"
expect_equal "and the old backups are all still there" "$BEFORE" "$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 | sort | md5sum)"
KEEP_DAYS=abc expect_failure "backup.sh refuses a nonsense KEEP_DAYS" "$BACKUP"

echo "restore into the SECOND, fresh Postgres"
export TIQ_DB_EXEC="docker exec -i $DST"
expect_success "restore of triageiq succeeds" "$RESTORE" "$DAY/triageiq.dump" --yes
expect_success "restore of gateway succeeds" "$RESTORE" "$DAY/gateway.dump" --yes
DST_APP="$(counts "$DST" triageiq)"; DST_GW="$(counts "$DST" gateway)"
echo "  restored triageiq: $DST_APP"; echo "  restored gateway:  $DST_GW"
expect_equal "ROW COUNTS: triageiq tables match the source, table by table" "$SRC_APP" "$DST_APP"
expect_equal "ROW COUNTS: gateway tables match the source, table by table" "$SRC_GW" "$DST_GW"
expect_equal "a unicode value survived" "Ọbiọma Ụzọ ✓ 7" "$(sql "$DST" triageiq "select content from kb_documents where topic='topic 7'")"
expect_equal "a vector survived" "[7,2,3]" "$(sql "$DST" triageiq "select embedding from kb_documents where topic='topic 7'")"
expect_equal "jsonb survived" "100" "$(sql "$DST" triageiq "select ai_usage->>'total_tokens' from tickets limit 1")"
expect_equal "a checksum of all ticket data matches" "$(sql "$SRC" triageiq "select md5(string_agg(subject||body||ai_cost_usd::text, ',' order by subject)) from tickets")" "$(sql "$DST" triageiq "select md5(string_agg(subject||body||ai_cost_usd::text, ',' order by subject)) from tickets")"
expect_equal "ownership came back with it (tables owned by triageiq_app)" "triageiq_app" "$(sql "$DST" triageiq "select pg_get_userbyid(relowner) from pg_class where relname='tickets'")"
expect_equal "the gateway database is owned by the gateway role again" "gateway" "$(sql "$DST" gateway "select pg_get_userbyid(relowner) from pg_class where relname='users'")"
expect_equal "the app role can read the restored data" "250" "$(psql_as "$DST" triageiq_app "$APPPW" triageiq "select count(*) from tickets")"
expect_failure "role isolation survived the restore: app role still cannot enter gateway" psql_as "$DST" triageiq_app "$APPPW" gateway "select 1"

echo "restore OVER a damaged live database (the real use)"
sql "$DST" triageiq "delete from tickets where subject like 's1%'; drop table kb_documents cascade" >/dev/null
expect_success "restore over it succeeds" "$RESTORE" "$DAY/triageiq.dump" --yes
expect_equal "everything is back" "$SRC_APP" "$(counts "$DST" triageiq)"
sql "$DST" triageiq "create table zz_made_after_the_backup(i int); insert into zz_made_after_the_backup values (1)" >/dev/null
expect_success "restore over a database that gained a table since the backup" "$RESTORE" "$DAY/triageiq.dump" --yes
expect_equal "the restore is EXACT: the table made after the backup is gone" "t" "$(sql "$DST" triageiq "select to_regclass('zz_made_after_the_backup') is null")"
expect_equal "and the data is as backed up" "$SRC_APP" "$(counts "$DST" triageiq)"
expect_equal "the app role still owns its schema rights (can create a table after the restore)" "ok" "$(psql_as "$DST" triageiq_app "$APPPW" triageiq "create table t_after(i int); drop table t_after; select 'ok'" | tail -1)"
expect_equal "running restore twice is fine" "0" "$("$RESTORE" "$DAY/triageiq.dump" --yes >/dev/null 2>&1; echo $?)"

echo "restore refusals change nothing"
SNAP="$(counts "$DST" triageiq)"
echo "this is not a dump" > "$ROOT/triageiq.dump"
expect_failure "a corrupt dump is refused" "$RESTORE" "$ROOT/triageiq.dump" --yes
cp "$DAY/triageiq.dump" "$ROOT/other.dump"
expect_failure "a dump with an unexpected name is refused" "$RESTORE" "$ROOT/other.dump" --yes
expect_failure "without --yes and without a terminal it refuses" "$RESTORE" "$DAY/triageiq.dump"
expect_failure "no file given is refused" "$RESTORE"
cp "$DAY/gateway.dump" "$ROOT/renamed/triageiq.dump" 2>/dev/null || { mkdir -p "$ROOT/renamed"; cp "$DAY/gateway.dump" "$ROOT/renamed/triageiq.dump"; }
expect_failure "the gateway's dump renamed to triageiq.dump is refused (it is a dump of another database)" "$RESTORE" "$ROOT/renamed/triageiq.dump" --yes
# a dump cut off half way: the restore must FAIL and leave the live database exactly as it was
mkdir -p "$ROOT/cut"; SIZE="$(stat -c %s "$DAY/triageiq.dump")"; head -c $((SIZE * 6 / 10)) "$DAY/triageiq.dump" > "$ROOT/cut/triageiq.dump"
expect_failure "a truncated dump does not restore" "$RESTORE" "$ROOT/cut/triageiq.dump" --yes
expect_equal "the database is exactly as it was" "$SNAP" "$(counts "$DST" triageiq)"

finish
