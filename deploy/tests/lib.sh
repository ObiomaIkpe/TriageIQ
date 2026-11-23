# Shared helpers for the deploy tests. Sourced, not run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
RUN_ID="$$"
CLEANUP_CONTAINERS=()
CLEANUP_DIRS=()
FAILURES=0

cleanup() {
  local c d
  for c in "${CLEANUP_CONTAINERS[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true; done
  for d in "${CLEANUP_DIRS[@]:-}"; do [ -n "$d" ] && [ -d "$d" ] && rm -rf "$d" || true; done
}
trap cleanup EXIT

pass() { echo "  ok   - $1"; }
fail() { echo "  FAIL - $1" >&2; FAILURES=$((FAILURES + 1)); }
expect_success() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi; }
expect_failure() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$label (it succeeded, it must not)"; else pass "$label"; fi; }
expect_equal() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
finish() { if [ "$FAILURES" -gt 0 ]; then echo "$FAILURES check(s) FAILED" >&2; exit 1; fi; echo "all checks passed"; }

# wait_pg <container> <user> <password> <db>: waits until Postgres answers over TCP (not while the image runs its init scripts).
wait_pg() {
  local container="$1" user="$2" password="$3" db="$4" i
  for i in $(seq 1 90); do
    if docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U "$user" -d "$db" -tAc 'select 1' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Postgres in $container did not become ready" >&2; docker logs "$container" 2>&1 | tail -20 >&2; return 1
}

# psql_as <container> <user> <password> <db> <sql>: runs one statement with a password; prints the bare result.
# It connects to the container's own network address, NOT 127.0.0.1: the postgres image trusts loopback connections,
# and only a connection from another address is made to give the right password.
psql_as() {
  local ip
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1")"
  docker exec -e PGPASSWORD="$3" "$1" psql -h "$ip" -v ON_ERROR_STOP=1 -U "$2" -d "$4" -tAc "$5"
}
