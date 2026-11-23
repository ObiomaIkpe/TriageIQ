#!/usr/bin/env bash
# The edge stack (deploy/edge): both Caddyfiles validated by `caddy validate` IN THE PINNED IMAGE, and static checks of its compose file
# and of the TriageIQ site file. Nothing is started.
source "$(dirname "$0")/lib.sh"

EDGE="$REPO/deploy/edge"
IMAGE="$(grep -E '^\s+image: caddy:' "$EDGE/docker-compose.yml" | awk '{print $2}')"
echo "caddy image: $IMAGE"
expect_success "the caddy image is pinned to an exact x.y.z version (never latest or 2)" bash -c "echo '$IMAGE' | grep -Eq '^caddy:[0-9]+\.[0-9]+\.[0-9]+(-alpine)?\$'"

validate() { # validate <caddyfile> [env...]
  local file="$1"; shift
  docker run --rm -v "$file":/etc/caddy/Caddyfile:ro -v "$EDGE/sites":/etc/caddy/sites:ro "$@" "$IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
}
echo "caddy validate"
expect_success "Caddyfile (production) is valid" validate "$EDGE/Caddyfile" -e ACME_EMAIL=ops@example.com
expect_success "Caddyfile.local-test is valid" validate "$EDGE/Caddyfile.local-test" -e TRIAGEIQ_HOST=triageiq.localhost
expect_failure "the check is real: a broken site file is rejected" bash -c "
  d=\$(mktemp -d); cp -r '$EDGE/sites' \$d/sites; echo 'broken.example { reverse_proxy' >> \$d/sites/broken.caddy
  docker run --rm -v '$EDGE/Caddyfile':/etc/caddy/Caddyfile:ro -v \$d/sites:/etc/caddy/sites:ro -e ACME_EMAIL=a@b.c '$IMAGE' caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
expect_success "the production Caddyfile reads every file in sites/" grep -q '^import sites/\*.caddy' "$EDGE/Caddyfile"
expect_equal "the ACME email comes from the environment, not from the file" "1" "$(grep -c 'email {\$ACME_EMAIL}' "$EDGE/Caddyfile")"

echo "the edge compose file"
export ACME_EMAIL=ops@example.com
docker compose -f "$EDGE/docker-compose.yml" config --format json > "${TMPDIR:-/tmp}/edge.$$.json" || fail "edge compose resolves"
docker compose -f "$EDGE/docker-compose.yml" -f "$EDGE/docker-compose.local-test.yml" config --format json > "${TMPDIR:-/tmp}/edge-lt.$$.json" || fail "edge local-test resolves"
unset ACME_EMAIL
expect_failure "ACME_EMAIL is required" docker compose -f "$EDGE/docker-compose.yml" config -q
python3 - "${TMPDIR:-/tmp}/edge.$$.json" "${TMPDIR:-/tmp}/edge-lt.$$.json" <<'PY' | while IFS= read -r line; do case "$line" in OK*) echo "  ok   - ${line#OK }";; *) echo "  FAIL - ${line#FAIL }" >&2; echo F >> "${TMPDIR:-/tmp}/edge-fail.$PPID";; esac; done
import json, sys
prod, test = (json.load(open(p)) for p in sys.argv[1:3])
def check(label, cond): print(("OK " if cond else "FAIL ") + label)
S = prod["services"]
check("one service: caddy", list(S) == ["caddy"])
c = S["caddy"]
ports = sorted((p["published"], p["protocol"]) for p in c["ports"])
check(f"it publishes exactly 80/tcp, 443/tcp, 443/udp {ports}", ports == [("443", "tcp"), ("443", "udp"), ("80", "tcp")])
check("none of them is bound to a single interface (the public ones: all addresses)", all(not p.get("host_ip") for p in c["ports"]))
check("certificates survive restarts: a named volume on /data (and /config)", {v["target"] for v in c["volumes"] if v["type"] == "volume"} == {"/data", "/config"})
check("the Caddyfile and the sites/ folder are mounted read-only", all(v.get("read_only") for v in c["volumes"] if v["type"] == "bind"))
check("it joins only the external network edge", list(c["networks"]) == ["edge"] and prod["networks"]["edge"]["external"] is True and prod["networks"]["edge"]["name"] == "edge")
check("restart unless-stopped, a memory limit, a healthcheck", c["restart"] == "unless-stopped" and int(c["mem_limit"]) <= 256 * 2**20 and "healthcheck" in c)
check("capabilities dropped except binding low ports", c["cap_drop"] == ["ALL"] and c["cap_add"] == ["NET_BIND_SERVICE"] and "no-new-privileges:true" in c["security_opt"])
check("json-file logging with rotation", c["logging"]["driver"] == "json-file" and c["logging"]["options"] == {"max-size": "10m", "max-file": "3"})
check("the admin API port is not published", all(p["target"] != 2019 for p in c["ports"]))
T = test["services"]["caddy"]
check("local-test: published on 127.0.0.1 only, never on 80/443", all(p.get("host_ip") == "127.0.0.1" and p["published"] in ("8080", "8443") for p in T["ports"]) and len(T["ports"]) == 2)
check("local-test: uses the local-CA Caddyfile and host triageiq.localhost", any("Caddyfile.local-test" in v["source"] for v in T["volumes"]) and T["environment"]["TRIAGEIQ_HOST"] == "triageiq.localhost")
PY
if [ -f "${TMPDIR:-/tmp}/edge-fail.$$" ]; then FAILURES=$((FAILURES + $(wc -l < "${TMPDIR:-/tmp}/edge-fail.$$"))); fi
command rm -f "${TMPDIR:-/tmp}/edge.$$.json" "${TMPDIR:-/tmp}/edge-lt.$$.json" "${TMPDIR:-/tmp}/edge-fail.$$"

echo "the TriageIQ site file"
SITE="$EDGE/sites/triageiq.caddy"
has() { grep -qF -- "$2" "$SITE" && pass "$1" || fail "$1"; }
has "the real host is the default" 'triageiq.bamstoneopus.com'
has "the /api prefix is stripped before the gateway" 'uri strip_prefix /api'
has "the gateway upstream is the prefixed name on port 3000" 'reverse_proxy triageiq-gateway:3000'
has "the web upstream is the prefixed name on port 8080" 'reverse_proxy triageiq-web:8080'
has "X-Forwarded-For is REPLACED with the address Caddy saw (one trusted hop)" 'header_up X-Forwarded-For {http.request.remote.host}'
has "X-Forwarded-Proto is stated" 'header_up X-Forwarded-Proto {http.request.scheme}'
has "HSTS" 'Strict-Transport-Security "max-age=31536000"'
has "zstd and gzip" 'encode zstd gzip'
has "JSON access log with rotation" 'roll_size 10MiB'
has "the access log drops the API key header" 'request>headers>X-Api-Key delete'
has "the access log drops cookies" 'request>headers>Cookie delete'
has "the access log drops Authorization" 'request>headers>Authorization delete'
has "the public form's body limit is 24KB" 'max_size 24KB'
has "the general API body limit is 128KB" 'max_size 128KB'
expect_equal "no bare 'gateway:' or 'web:' upstream anywhere" "0" "$(grep -cE 'reverse_proxy (gateway|web|app):' "$SITE" || true)"
# the limits sit just above the gateway's own (100 KB general, 16 KB on /public)
expect_equal "gateway limits are as the Caddy limits assume (100kb / 16kb)" "2" "$(grep -cE "BODY_LIMIT = '(100kb|16kb)'" "$REPO/gateway/src/app.setup.ts" "$REPO/gateway/src/public-tickets/public.constants.ts" | awk -F: '{s+=$2} END{print s}')"
finish
