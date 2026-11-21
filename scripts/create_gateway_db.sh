#!/usr/bin/env bash
# Creates the gateway's database and role in an EXISTING Postgres volume, where the init script
# in db/init does not run again. Safe to run any number of times. Run from anywhere:
#   scripts/create_gateway_db.sh
# Needs the db container to have GATEWAY_DB_PASSWORD (set it in the root .env, then
# `docker compose up -d db` once, so the container is recreated with it).
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose exec -T db sh -c '
  if [ -z "${GATEWAY_DB_PASSWORD:-}" ]; then
    echo "GATEWAY_DB_PASSWORD is not set in the db container." >&2
    echo "Add it to .env, then run: docker compose up -d db" >&2
    exit 1
  fi
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -f -
' < db/gateway-db.sql

echo "The gateway database and role are in place."
