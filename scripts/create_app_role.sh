#!/usr/bin/env bash
# Creates the least-privilege role the Python service uses (triageiq_app) in an EXISTING Postgres volume, where the init
# scripts in db/init do not run again, and hands the objects of the triageiq database over to it. Safe to run any
# number of times. Run from anywhere:
#   scripts/create_app_role.sh
# Needs the db container to have TRIAGEIQ_APP_DB_PASSWORD (set it in the root .env, then `docker compose up -d db` once, so
# the container is recreated with it). Afterwards DATABASE_URL (root .env / compose) must use triageiq_app: see README.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose exec -T db sh -c '
  if [ -z "${TRIAGEIQ_APP_DB_PASSWORD:-}" ]; then
    echo "TRIAGEIQ_APP_DB_PASSWORD is not set in the db container." >&2
    echo "Add it to .env, then run: docker compose up -d db" >&2
    exit 1
  fi
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -f -
' < db/app-db.sql

echo "The triageiq_app role is in place and owns the triageiq database."
