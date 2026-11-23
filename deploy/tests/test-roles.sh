#!/usr/bin/env bash
# Role isolation, on throwaway Postgres containers (no ports published, nothing of yours touched):
#   A. a FRESH volume: the init scripts in deploy/db create the roles and databases;
#   B. an EXISTING volume that has superuser-owned objects: db/app-db.sql hands them over, and running it twice changes nothing.
# Run from anywhere:  deploy/tests/test-roles.sh
source "$(dirname "$0")/lib.sh"

ADMIN=tiq_admin ADMINPW=admin-pw-$RUN_ID APPPW=app-pw-$RUN_ID GWPW=gw-pw-$RUN_ID

echo "0. deploy/db is an exact copy of db/"
for f in app-db.sql gateway-db.sql init/10-gateway-db.sh init/20-app-db.sh; do
  expect_success "deploy/db/$f equals db/$f" cmp "$REPO/db/$f" "$REPO/deploy/db/$f"
done

# --- A: fresh volume -------------------------------------------------------------------------------------------------
echo "A. fresh volume (init scripts)"
A="tiq-roles-fresh-$RUN_ID"; CLEANUP_CONTAINERS+=("$A")
docker run -d --name "$A" \
  -e POSTGRES_USER=$ADMIN -e POSTGRES_PASSWORD=$ADMINPW -e POSTGRES_DB=triageiq \
  -e GATEWAY_DB_PASSWORD=$GWPW -e TRIAGEIQ_APP_DB_PASSWORD=$APPPW \
  -v "$REPO/deploy/db/init:/docker-entrypoint-initdb.d:ro" \
  -v "$REPO/deploy/db/gateway-db.sql:/gateway-db.sql:ro" -v "$REPO/deploy/db/app-db.sql:/app-db.sql:ro" \
  "$PG_IMAGE" >/dev/null
wait_pg "$A" $ADMIN $ADMINPW triageiq

as_app()  { psql_as "$A" triageiq_app "$APPPW" "$1" "$2"; }
as_gw()   { psql_as "$A" gateway "$GWPW" "$1" "$2"; }
as_admin(){ psql_as "$A" $ADMIN "$ADMINPW" "$1" "$2"; }

expect_equal "the app role is not a superuser" "f" "$(as_app triageiq "select rolsuper from pg_roles where rolname = current_user")"
expect_equal "the app role cannot create roles or databases" "f|f" "$(as_app triageiq "select rolcreaterole, rolcreatedb from pg_roles where rolname = current_user" | tr -d ' ')"
expect_equal "the app role owns the triageiq database" "triageiq_app" "$(as_admin postgres "select pg_get_userbyid(datdba) from pg_database where datname = 'triageiq'")"
expect_equal "pgvector was created by the superuser, in triageiq" "$ADMIN" "$(as_admin triageiq "select pg_get_userbyid(extowner) from pg_extension where extname = 'vector'")"
expect_success "the app role can create tables in triageiq (Alembic can migrate)" as_app triageiq "create table t_probe(id int); drop table t_probe"
expect_success "the app role can use the vector type" as_app triageiq "select '[1,2,3]'::vector(3)"
expect_failure "the app role cannot connect to the gateway database" as_app gateway "select 1"
expect_failure "the app role cannot connect to the postgres maintenance database" as_app postgres "select 1"
expect_failure "the app role cannot create a role" as_app triageiq "create role sneaky login"
expect_failure "the app role cannot create a database" as_app triageiq "create database sneaky"
expect_success "the gateway role can connect to the gateway database" as_gw gateway "select 1"
expect_failure "the gateway role cannot connect to the triageiq database" as_gw triageiq "select 1"
expect_failure "the gateway role cannot connect to postgres" as_gw postgres "select 1"
expect_failure "the app role's password does not open the superuser login" psql_as "$A" $ADMIN "$APPPW" triageiq "select 1"
expect_failure "the app role cannot reach the gateway database's tables via the other role's name" psql_as "$A" gateway "$APPPW" gateway "select 1"

# the init scripts refuse an unset password
B0="tiq-roles-nopw-$RUN_ID"; CLEANUP_CONTAINERS+=("$B0")
docker run -d --name "$B0" -e POSTGRES_USER=$ADMIN -e POSTGRES_PASSWORD=$ADMINPW -e POSTGRES_DB=triageiq \
  -e GATEWAY_DB_PASSWORD=$GWPW \
  -v "$REPO/deploy/db/init:/docker-entrypoint-initdb.d:ro" -v "$REPO/deploy/db/gateway-db.sql:/gateway-db.sql:ro" -v "$REPO/deploy/db/app-db.sql:/app-db.sql:ro" \
  "$PG_IMAGE" >/dev/null
for i in $(seq 1 40); do [ "$(docker inspect -f '{{.State.Running}}' "$B0")" = "false" ] && break; sleep 1; done
expect_equal "a missing TRIAGEIQ_APP_DB_PASSWORD stops the init (the container exits)" "false" "$(docker inspect -f '{{.State.Running}}' "$B0")"
if docker logs "$B0" 2>&1 | grep -q "TRIAGEIQ_APP_DB_PASSWORD is not set"; then pass "and says why"; else fail "and says why"; fi

# --- B: existing volume with superuser-owned objects --------------------------------------------------------------------
echo "B. existing volume (a superuser-owned database, as on a laptop that predates the role)"
B="tiq-roles-existing-$RUN_ID"; CLEANUP_CONTAINERS+=("$B")
docker run -d --name "$B" -e POSTGRES_USER=$ADMIN -e POSTGRES_PASSWORD=$ADMINPW -e POSTGRES_DB=triageiq \
  -e GATEWAY_DB_PASSWORD=$GWPW -e TRIAGEIQ_APP_DB_PASSWORD=$APPPW \
  -v "$REPO/deploy/db/gateway-db.sql:/gateway-db.sql:ro" -v "$REPO/deploy/db/app-db.sql:/app-db.sql:ro" \
  "$PG_IMAGE" >/dev/null     # NO init scripts: the volume "already existed"
wait_pg "$B" $ADMIN $ADMINPW triageiq
psql_b() { psql_as "$B" $ADMIN "$ADMINPW" "$1" "$2"; }
psql_b triageiq "create extension vector; create table kb(id serial primary key, e vector(3)); create table tickets(id uuid primary key default gen_random_uuid(), n text);
  create sequence stray_seq; create type mood as enum ('a','b'); create function f1() returns int language sql as 'select 1'; create view v1 as select * from tickets;
  insert into tickets(n) values ('keep me'), ('and me');" >/dev/null
docker exec -e PGPASSWORD="$ADMINPW" "$B" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U $ADMIN -d postgres -f /gateway-db.sql >/dev/null

owners() { psql_b triageiq "select string_agg(distinct pg_get_userbyid(relowner), ',') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','S','v','i')"; }
expect_equal "before: the superuser owns the tables" "$ADMIN" "$(owners)"

run_script() { docker exec -e PGPASSWORD="$ADMINPW" "$B" sh -c "psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U $ADMIN -d postgres -f /app-db.sql"; }
expect_success "the script runs" run_script
expect_equal "after: the app role owns every table, sequence, view and index" "triageiq_app" "$(owners)"
expect_equal "the enum type moved" "triageiq_app" "$(psql_b triageiq "select pg_get_userbyid(typowner) from pg_type where typname='mood'")"
expect_equal "the function moved" "triageiq_app" "$(psql_b triageiq "select pg_get_userbyid(proowner) from pg_proc where proname='f1'")"
expect_equal "the extension stayed with the superuser" "$ADMIN" "$(psql_b triageiq "select pg_get_userbyid(extowner) from pg_extension where extname='vector'")"
expect_equal "no row was touched" "2" "$(psql_b triageiq "select count(*) from tickets")"
expect_equal "the app role can read the data" "2" "$(psql_as "$B" triageiq_app "$APPPW" triageiq "select count(*) from tickets")"
expect_success "the app role can alter its tables (a migration would work)" psql_as "$B" triageiq_app "$APPPW" triageiq "alter table tickets add column extra text"
expect_failure "the app role cannot connect to the gateway database" psql_as "$B" triageiq_app "$APPPW" gateway "select 1"
expect_failure "the gateway role cannot connect to the triageiq database" psql_as "$B" gateway "$GWPW" triageiq "select 1"
expect_success "the gateway role still connects to its own" psql_as "$B" gateway "$GWPW" gateway "select 1"

SNAP1="$(psql_b triageiq "select md5(string_agg(c.relname||pg_get_userbyid(c.relowner), ',' order by c.relname)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'")"
expect_success "running it a SECOND time works" run_script
SNAP2="$(psql_b triageiq "select md5(string_agg(c.relname||pg_get_userbyid(c.relowner), ',' order by c.relname)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'")"
expect_equal "and changes nothing" "$SNAP1" "$SNAP2"
expect_equal "still no row touched" "2" "$(psql_b triageiq "select count(*) from tickets")"

# the same script after the gateway role was created, in the other order, is also fine (gateway script after app script)
expect_success "the gateway script runs again afterwards" docker exec -e PGPASSWORD="$ADMINPW" "$B" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U $ADMIN -d postgres -f /gateway-db.sql
expect_success "and the app role still connects to its database" psql_as "$B" triageiq_app "$APPPW" triageiq "select 1"

# the real Alembic migrations, run AS the app role against the existing volume (needs the project's Python; skipped without it)
if [ -n "${TIQ_PYTHON:-}" ]; then
  echo "C. the real Alembic migrations as triageiq_app"
  PORT_B="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$B")"
  # a database with the app's real tables made by the superuser first, then handed over
  C="tiq-roles-alembic-$RUN_ID"; CLEANUP_CONTAINERS+=("$C")
  docker run -d --name "$C" -e POSTGRES_USER=$ADMIN -e POSTGRES_PASSWORD=$ADMINPW -e POSTGRES_DB=triageiq \
    -e GATEWAY_DB_PASSWORD=$GWPW -e TRIAGEIQ_APP_DB_PASSWORD=$APPPW \
    -v "$REPO/deploy/db/gateway-db.sql:/gateway-db.sql:ro" -v "$REPO/deploy/db/app-db.sql:/app-db.sql:ro" "$PG_IMAGE" >/dev/null
  wait_pg "$C" $ADMIN $ADMINPW triageiq
  IP_C="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$C")"
  (cd "$REPO" && ANTHROPIC_API_KEY=x VOYAGE_API_KEY=x DATABASE_URL="postgresql://$ADMIN:$ADMINPW@$IP_C:5432/triageiq" "$TIQ_PYTHON" -c "from app.migrations import run_migrations; run_migrations()") >/dev/null 2>&1 \
    && pass "the superuser built the OLD-style database (migrations 0001-0005)" || fail "superuser migration"
  docker exec -e PGPASSWORD="$ADMINPW" "$C" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U $ADMIN -d postgres -f /gateway-db.sql >/dev/null
  docker exec -e PGPASSWORD="$ADMINPW" "$C" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U $ADMIN -d postgres -f /app-db.sql >/dev/null && pass "role script on the migrated database" || fail "role script"
  expect_equal "tickets is owned by the app role" "triageiq_app" "$(psql_as "$C" $ADMIN "$ADMINPW" triageiq "select pg_get_userbyid(relowner) from pg_class where relname='tickets'")"
  (cd "$REPO" && ANTHROPIC_API_KEY=x VOYAGE_API_KEY=x DATABASE_URL="postgresql://triageiq_app:$APPPW@$IP_C:5432/triageiq" "$TIQ_PYTHON" - <<'PY'
from app.migrations import run_migrations
run_migrations()            # nothing pending: must not need superuser (CREATE EXTENSION IF NOT EXISTS vector is a no-op)
from app.graph.checkpointer import create_checkpointer
import os
cp = create_checkpointer(os.environ["DATABASE_URL"])   # creates / checks the LangGraph tables as the app role
cp.close()
PY
  ) >/dev/null 2>&1 && pass "the app role runs the migrations and opens the checkpointer" || fail "app role migrations / checkpointer"
fi

finish
