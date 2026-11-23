-- Gives the Python service its OWN least-privilege database role, so it no longer runs as the Postgres superuser.
-- Idempotent: safe to run any number of times (it also keeps the role's password in step with TRIAGEIQ_APP_DB_PASSWORD).
--
--   role      triageiq_app: can log in; owns the triageiq database and every object in it (so Alembic can migrate);
--             is NOT a superuser and cannot create roles or databases; may connect to no other database.
--   database  triageiq: only triageiq_app (and superusers) may connect. The gateway role cannot.
--   extension pgvector is created HERE, by the superuser, before the app starts (the app's migration 0001 then finds it).
--
-- The password is read from the TRIAGEIQ_APP_DB_PASSWORD environment variable of the psql process (\getenv), so it never
-- appears in a command line. Run as the database superuser:
--   psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -f app-db.sql
-- It runs automatically on a fresh volume (db/init/20-app-db.sh) and by scripts/create_app_role.sh on an existing one.
-- It works in an existing database too: objects owned by the superuser are handed to triageiq_app with ALTER ... OWNER
-- (never REASSIGN OWNED: that would also try to take the system databases, which the bootstrap superuser owns).

-- Refuse an unset OR EMPTY password (Postgres treats an empty password as "no password").
\getenv app_password TRIAGEIQ_APP_DB_PASSWORD
\set has_password 0
\if :{?app_password}
  SELECT length(:'app_password') > 0 AS has_password \gset
\endif
\if :has_password
\else
  DO $$ BEGIN RAISE EXCEPTION 'TRIAGEIQ_APP_DB_PASSWORD is not set or is empty'; END $$;
\endif

SELECT format('CREATE ROLE triageiq_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'triageiq_app') \gexec

SELECT format('ALTER ROLE triageiq_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'app_password') \gexec

-- The database: created if it is missing (the postgres image already creates it from POSTGRES_DB), owned by the role.
SELECT 'CREATE DATABASE triageiq OWNER triageiq_app'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'triageiq') \gexec
ALTER DATABASE triageiq OWNER TO triageiq_app;

-- Only triageiq_app may connect to it (PUBLIC can by default), and triageiq_app may connect to no other database.
REVOKE ALL ON DATABASE triageiq FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE triageiq TO triageiq_app;

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', datname)
FROM pg_database
WHERE datname NOT IN ('triageiq', 'template0', 'template1') AND datallowconn \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM triageiq_app', datname)
FROM pg_database
WHERE datname <> 'triageiq' AND datallowconn \gexec

-- The gateway role (db/gateway-db.sql) must not get into this database either; it may not exist yet.
SELECT 'REVOKE ALL ON DATABASE triageiq FROM gateway'
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'gateway') \gexec

-- From here on: inside the triageiq database.
\connect triageiq

CREATE EXTENSION IF NOT EXISTS vector;

-- Hand every object the superuser owns here (an existing volume) to triageiq_app. Objects that belong to an extension
-- stay with it. A fresh database has nothing to move, so this does nothing there.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND pg_get_userbyid(c.relowner) <> 'triageiq_app'
      -- not a member of an extension
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      -- not a sequence that belongs to a column (it follows its table)
      AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')))
    ORDER BY c.relkind = 'S', c.oid
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO triageiq_app', r.schema_name, r.object_name);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I OWNER TO triageiq_app', r.schema_name, r.object_name);
    END IF;
  END LOOP;

  -- Types made by hand (enums, domains, ranges). Row types and array types follow their table / element type.
  FOR r IN
    SELECT n.nspname AS schema_name, t.typname AS object_name
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      AND t.typtype IN ('e', 'd', 'r', 'm')
      AND pg_get_userbyid(t.typowner) <> 'triageiq_app'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO triageiq_app', r.schema_name, r.object_name);
  END LOOP;

  -- Functions and procedures made by hand.
  FOR r IN
    SELECT p.oid::regprocedure AS signature, p.prokind
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      AND p.prokind IN ('f', 'p')
      AND pg_get_userbyid(p.proowner) <> 'triageiq_app'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO triageiq_app', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.signature);
  END LOOP;

  -- Schemas: public is owned by pg_database_owner on PG 15+ (which is triageiq_app now); older volumes have the superuser.
  FOR r IN
    SELECT nspname AS schema_name FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'
      AND pg_get_userbyid(nspowner) NOT IN ('triageiq_app', 'pg_database_owner')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_namespace'::regclass AND d.objid = pg_namespace.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO triageiq_app', r.schema_name);
  END LOOP;
END
$$;
