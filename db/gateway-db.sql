-- Creates the gateway's own role and database inside the existing Postgres. Idempotent: safe to
-- run any number of times (it also keeps the role's password in step with GATEWAY_DB_PASSWORD).
--
-- The password is read from the GATEWAY_DB_PASSWORD environment variable of the psql process
-- (\getenv), so it never appears in a command line. Run it as the database superuser:
--   psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -f gateway-db.sql
-- It is run automatically on a fresh volume (db/init/10-gateway-db.sh) and by
-- scripts/create_gateway_db.sh on an existing one.

-- Refuse an unset OR EMPTY password (Postgres treats an empty password as "no password").
\getenv gateway_password GATEWAY_DB_PASSWORD
\set has_password 0
\if :{?gateway_password}
  SELECT length(:'gateway_password') > 0 AS has_password \gset
\endif
\if :has_password
\else
  DO $$ BEGIN RAISE EXCEPTION 'GATEWAY_DB_PASSWORD is not set or is empty'; END $$;
\endif

-- The role: can log in, owns only the gateway database, has no other powers.
SELECT format('CREATE ROLE gateway LOGIN PASSWORD %L', :'gateway_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gateway') \gexec

SELECT format('ALTER ROLE gateway WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'gateway_password') \gexec

-- The database, owned by that role.
SELECT 'CREATE DATABASE gateway OWNER gateway'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gateway') \gexec

-- Nobody else may connect to the gateway database (PUBLIC can by default), and the gateway role
-- may connect to no other database. Without the second part PUBLIC's default CONNECT right would
-- let it into Python's database, so it is withdrawn from every other connectable database.
REVOKE ALL ON DATABASE gateway FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE gateway TO gateway;

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', datname)
FROM pg_database
WHERE datname NOT IN ('gateway', 'template0', 'template1') AND datallowconn \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM gateway', datname)
FROM pg_database
WHERE datname <> 'gateway' AND datallowconn \gexec
