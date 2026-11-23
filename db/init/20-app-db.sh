#!/bin/sh
# Runs once, when the database volume is created (after 10-gateway-db.sh). On an existing volume it does NOT run again:
# use scripts/create_app_role.sh there. The SQL is idempotent, so running both does no harm.
set -eu
if [ -z "${TRIAGEIQ_APP_DB_PASSWORD:-}" ]; then
  echo "TRIAGEIQ_APP_DB_PASSWORD is not set: cannot create the application role" >&2
  exit 1
fi
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -f /app-db.sql
