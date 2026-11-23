#!/usr/bin/env bash
# deploy/db/ is a copy of db/ (the server has only the deploy/ folder, not the source). The development stack mounts db/,
# the production stack mounts deploy/db/. Run this after changing anything in db/; CI (deploy/tests) fails if they differ.
set -euo pipefail
cd "$(dirname "$0")/.."
cp db/app-db.sql db/gateway-db.sql deploy/db/
cp db/init/10-gateway-db.sh db/init/20-app-db.sh deploy/db/init/
echo "deploy/db is in step with db."
