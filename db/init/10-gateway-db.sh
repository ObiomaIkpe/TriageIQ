#!/bin/sh
# Runs once, when the database volume is created (the postgres image runs everything in
# /docker-entrypoint-initdb.d). On an existing volume it does NOT run again: use
# scripts/create_gateway_db.sh there. The SQL is idempotent, so running both does no harm.
set -eu
if [ -z "${GATEWAY_DB_PASSWORD:-}" ]; then
  echo "GATEWAY_DB_PASSWORD is not set: cannot create the gateway database" >&2
  exit 1
fi
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -f /gateway-db.sql
