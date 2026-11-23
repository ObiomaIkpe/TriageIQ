#!/usr/bin/env bash
# Runs the WHOLE production shape on your own machine, from this repository's source, with throwaway data:
# the edge Caddy (deploy/edge, Caddy's local CA instead of Let's Encrypt) in front of the production stack, on a throwaway "edge" network.
# Separate from your development stack: own compose projects, volumes and networks, fake provider keys, ports on 127.0.0.1 only.
#
#   deploy/local-test.sh up          build the three images, create deploy/env.local-test/ (git-ignored), start edge + stack
#   deploy/local-test.sh check       automatic checks: routing, headers, one-hop X-Forwarded-For, log redaction, name collisions
#   deploy/local-test.sh reviewer    create the test reviewer  tester@example.com / local-test-password-1234
#   deploy/local-test.sh status      containers, health, memory
#   deploy/local-test.sh down        stop everything and DELETE its volumes and networks (only these projects')
#
# Then open https://triageiq.localhost:8443 (Caddy's local CA is not trusted by your browser: accept the warning once).
#   /  the public form (Turnstile is OFF here: the production guard forbids Cloudflare's test secret)    /login   /queue
# Direct, no proxy: web http://127.0.0.1:8081   gateway http://127.0.0.1:3001
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${COMPOSE_PROJECT:-triageiq-local-test}"
EDGE_PROJECT="${EDGE_COMPOSE_PROJECT:-edge-local-test}"
export EDGE_NETWORK="${EDGE_NETWORK:-edge-local-test}"
export ENV_DIR="$HERE/env.local-test"
export TAG=local GHCR_OWNER=local ACME_EMAIL=local-test@example.com
BASE="https://triageiq.localhost:8443"
DC=(docker compose -p "$PROJECT" -f "$HERE/docker-compose.prod.yml" -f "$HERE/docker-compose.local-test.yml")
EDGE=(docker compose -p "$EDGE_PROJECT" -f "$HERE/edge/docker-compose.yml" -f "$HERE/edge/docker-compose.local-test.yml")

get() { { grep -m1 "^$2=" "$1" || true; } | cut -d= -f2-; }
put() { local f="$1" k="$2" v="$3" t; t="$(mktemp "$f.XXXXXX")"; KEYNAME="$k" NEWVALUE="$v" awk 'BEGIN{FS=OFS="=";k=ENVIRON["KEYNAME"];v=ENVIRON["NEWVALUE"]} $1==k&&!d{print k"="v;d=1;next}{print} END{if(!d)print k"="v}' "$f" > "$t"; chmod 600 "$t"; mv "$t" "$f"; }

prepare() {
  if [ -f "$ENV_DIR/.prepared" ]; then return; fi
  ENV_DIR="$ENV_DIR" "$HERE/make-secrets.sh" >/dev/null
  # Fake provider keys: no model call is ever made by this test. Obviously not real, and not a REPLACE_ME placeholder.
  put "$ENV_DIR/app.env" ANTHROPIC_API_KEY "sk-ant-local-test-not-a-real-key"
  put "$ENV_DIR/app.env" VOYAGE_API_KEY "pa-local-test-not-a-real-key"
  # The production guard really is on. These are the values a local run needs that it would also accept:
  put "$ENV_DIR/gateway.env" ALLOWED_ORIGINS "https://triageiq.localhost:8443"
  put "$ENV_DIR/gateway.env" PUBLIC_FORM_ENABLED "false"     # the only Turnstile secrets that work locally are Cloudflare's TEST ones, which the guard refuses
  put "$ENV_DIR/gateway.env" MAIL_ENABLED "false"
  put "$ENV_DIR/gateway.env" TURNSTILE_SECRET_KEY ""          # unused while the form is off; a placeholder would be refused
  put "$ENV_DIR/gateway.env" TURNSTILE_EXPECTED_HOSTNAMES "triageiq.localhost"
  # A real API client key, made with the real script in the real image.
  "${DC[@]}" build triageiq-gateway >/dev/null
  out="$(docker run --rm "ghcr.io/local/triageiq-gateway:local" node scripts/make-client-key.ts local-submitter submitter)"
  entry="$(printf '%s\n' "$out" | grep -m1 '^  {')"
  put "$ENV_DIR/gateway.env" GATEWAY_CLIENTS "'[${entry#  }]'"
  touch "$ENV_DIR/.prepared"
  echo "prepared $ENV_DIR (git-ignored; throwaway secrets)"
}

curl_edge() { curl -sk --resolve triageiq.localhost:8443:127.0.0.1 "$@"; }

check() {
  source "$HERE/tests/lib.sh"
  trap - EXIT   # lib.sh installs a cleanup trap for its own throwaway containers; this run only creates two small ones, removed below
  local h out edge_ip i
  echo "routing through the edge Caddy ($BASE)"
  expect_equal "web: / answers 200" "200" "$(curl_edge -o /dev/null -w '%{http_code}' $BASE/)"
  expect_equal "web: a client route (/queue) falls back to the app" "200" "$(curl_edge -o /dev/null -w '%{http_code}' $BASE/queue)"
  expect_equal "api: /api/health reaches the gateway with the prefix stripped" '{"status":"ok"}' "$(curl_edge $BASE/api/health)"
  expect_equal "api: /api/ready (gateway -> redis and the python app) is ready" "200" "$(curl_edge -o /dev/null -w '%{http_code}' $BASE/api/ready)"
  expect_equal "api: /api/auth/me is the gateway's 401, not the web app's page" "401" "$(curl_edge -o /dev/null -w '%{http_code}' $BASE/api/auth/me)"
  expect_equal "http on 8080 redirects to https" "308" "$(curl -s --resolve triageiq.localhost:8080:127.0.0.1 -o /dev/null -w '%{http_code}' http://triageiq.localhost:8080/)"
  expect_equal "an unknown Host header gets an EMPTY answer, never this app" "0" "$(curl_edge -H 'Host: other.example' $BASE/ | wc -c | tr -d ' ')"

  echo "headers"
  for path in / /api/health /queue; do
    h="$(curl_edge -D - -o /dev/null $BASE$path | tr -d '\r')"
    expect_equal "exactly ONE Strict-Transport-Security on $path" "1" "$(printf '%s\n' "$h" | grep -ci '^strict-transport-security:')"
    expect_equal "HSTS value on $path" "max-age=31536000" "$(printf '%s\n' "$h" | grep -i '^strict-transport-security:' | head -1 | cut -d: -f2- | tr -d ' ')"
    expect_equal "no Server header on $path" "0" "$(printf '%s\n' "$h" | grep -ci '^server:')"
  done
  expect_equal "the web CSP still arrives through the proxy" "1" "$(curl_edge -D - -o /dev/null $BASE/ | grep -ci '^content-security-policy:.*challenges.cloudflare.com')"
  expect_equal "zstd compression" "zstd" "$(curl_edge -H 'Accept-Encoding: zstd' -D - -o /dev/null $BASE/assets/$(curl_edge $BASE/ | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1) | tr -d '\r' | grep -i '^content-encoding:' | cut -d: -f2 | tr -d ' ')"
  expect_equal "gzip compression" "gzip" "$(curl_edge -H 'Accept-Encoding: gzip' -D - -o /dev/null $BASE/assets/$(curl_edge $BASE/ | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1) | tr -d '\r' | grep -i '^content-encoding:' | cut -d: -f2 | tr -d ' ')"

  echo "request body limits (128 KB on /api, 24 KB on /api/public)"
  head -c 200000 /dev/zero | tr '\0' 'a' > "${TMPDIR:-/tmp}/tiq-big.$$"
  head -c 30000 /dev/zero | tr '\0' 'a' > "${TMPDIR:-/tmp}/tiq-mid.$$"
  expect_equal "200 KB to /api/auth/login is cut off by Caddy (413)" "413" "$(curl_edge -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @"${TMPDIR:-/tmp}/tiq-big.$$" $BASE/api/auth/login)"
  expect_equal "30 KB to /api/public/tickets is cut off by Caddy (413)" "413" "$(curl_edge -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @"${TMPDIR:-/tmp}/tiq-mid.$$" $BASE/api/public/tickets)"
  expect_equal "30 KB to /api/auth/login is NOT cut off by Caddy (the gateway answers)" "1" "$([ "$(curl_edge -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @"${TMPDIR:-/tmp}/tiq-mid.$$" $BASE/api/auth/login)" != 413 ] && echo 1 || echo 0)"
  command rm -f "${TMPDIR:-/tmp}/tiq-big.$$" "${TMPDIR:-/tmp}/tiq-mid.$$"

  echo "one-hop X-Forwarded-For: a caller cannot choose its own address"
  for i in 1 2 3; do curl_edge -o /dev/null -H "X-Forwarded-For: 9.9.9.$i, 8.8.8.8" -H "Origin: $BASE" -H 'Content-Type: application/json' -d "{\"email\":\"x$i@example.com\",\"password\":\"wrong wrong wrong\"}" $BASE/api/auth/login; done
  out="$(docker exec "$PROJECT-redis-1" redis-cli --scan --pattern 'login_fail:ip:*' | sort)"
  expect_equal "failures were counted under ONE address" "1" "$(printf '%s\n' "$out" | grep -c .)"
  expect_equal "and it is not any address the caller sent" "0" "$(printf '%s\n' "$out" | grep -cE '9\.9\.9\.|8\.8\.8\.8' || true)"
  echo "  (counted as: $(printf '%s' "$out" | tr '\n' ' '))"

  echo "the access log is JSON and holds no credential"
  curl_edge -o /dev/null -H 'X-Api-Key: tiq_SECRETKEYSECRETKEY' -H 'Cookie: tiq_session=SECRETSESSIONVALUE' -H 'Authorization: Bearer SECRETBEARER' $BASE/api/auth/me
  sleep 1
  docker exec "$EDGE_PROJECT-caddy-1" cat /data/logs/triageiq-access.log > "${TMPDIR:-/tmp}/tiq-log.$$" 2>/dev/null || true
  expect_success "the log file exists and has lines" test -s "${TMPDIR:-/tmp}/tiq-log.$$"
  expect_equal "every line is valid JSON" "0" "$(while read -r l; do printf '%s' "$l" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null || echo bad; done < "${TMPDIR:-/tmp}/tiq-log.$$" | grep -c bad || true)"
  expect_equal "the API key is not in it" "0" "$(grep -c 'SECRETKEYSECRETKEY' "${TMPDIR:-/tmp}/tiq-log.$$" || true)"
  expect_equal "the session cookie is not in it" "0" "$(grep -c 'SECRETSESSIONVALUE' "${TMPDIR:-/tmp}/tiq-log.$$" || true)"
  expect_equal "the bearer token is not in it" "0" "$(grep -c 'SECRETBEARER' "${TMPDIR:-/tmp}/tiq-log.$$" || true)"
  command rm -f "${TMPDIR:-/tmp}/tiq-log.$$"

  echo "names on the edge network: only triageiq-gateway and triageiq-web"
  edge_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$EDGE_NETWORK\").IPAddress}}" "$PROJECT-triageiq-gateway-1")"
  expect_success "triageiq-gateway resolves on edge" docker run --rm --network "$EDGE_NETWORK" alpine nslookup triageiq-gateway
  expect_success "triageiq-web resolves on edge" docker run --rm --network "$EDGE_NETWORK" alpine nslookup triageiq-web
  expect_failure "the bare name 'gateway' does NOT resolve on edge" docker run --rm --network "$EDGE_NETWORK" alpine nslookup gateway
  expect_failure "the bare name 'web' does NOT resolve on edge" docker run --rm --network "$EDGE_NETWORK" alpine nslookup web
  expect_failure "the internal names (app, db, redis) do not resolve on edge either" docker run --rm --network "$EDGE_NETWORK" alpine sh -c 'nslookup app || nslookup db || nslookup redis'
  # another app that happens to have services called gateway and web must not be confused with ours
  docker run -d --name "tiq-decoy-$$" --network "$EDGE_NETWORK" --network-alias gateway --network-alias web caddy:2.11.9-alpine sleep 600 >/dev/null
  decoy_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$EDGE_NETWORK\").IPAddress}}" "tiq-decoy-$$")"
  expect_equal "an unrelated app's 'gateway' is theirs, not ours" "$decoy_ip" "$(docker run --rm --network "$EDGE_NETWORK" alpine nslookup gateway | awk '/^Address/ && !/#/ {print $2}' | tail -1)"
  expect_equal "while triageiq-gateway is still ours" "$edge_ip" "$(docker run --rm --network "$EDGE_NETWORK" alpine nslookup triageiq-gateway | awk '/^Address/ && !/#/ {print $2}' | tail -1)"
  docker rm -f "tiq-decoy-$$" >/dev/null 2>&1 || true

  echo "ports"
  expect_equal "the production stack publishes nothing except the two local-test ports on 127.0.0.1" "" "$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Ports}}' | tr ',' '\n' | grep -E '0\.0\.0\.0|\[::\]' || true)"
  expect_equal "the edge publishes only 80 and 443 (here on 127.0.0.1:8080 and :8443)" "127.0.0.1:8080->80/tcp 127.0.0.1:8443->443/tcp " "$(docker ps --filter "label=com.docker.compose.project=$EDGE_PROJECT" --format '{{.Ports}}' | tr ',' '\n' | grep -- '->' | sed 's/^ *//' | sort | tr '\n' ' ')"
  finish
}

case "${1:-}" in
  up)
    prepare
    docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1 || docker network create "$EDGE_NETWORK" >/dev/null
    "${DC[@]}" up -d --build
    "${EDGE[@]}" up -d
    echo; echo "Started projects $PROJECT and $EDGE_PROJECT. Wait ~1 minute for health, then:  $0 check"
    ;;
  check) check ;;
  status)
    "${DC[@]}" ps; "${EDGE[@]}" ps
    echo; docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}' $("${DC[@]}" ps -q) $("${EDGE[@]}" ps -q) 2>/dev/null || true
    ;;
  reviewer)
    printf '%s\n' "local-test-password-1234" | "${DC[@]}" exec -T triageiq-gateway node dist/scripts/reviewers.js create --email tester@example.com --name "Local Tester"
    ;;
  logs) shift; "${DC[@]}" logs "$@" ;;
  down)
    "${EDGE[@]}" down -v --remove-orphans
    "${DC[@]}" down -v --remove-orphans
    docker network rm "$EDGE_NETWORK" >/dev/null 2>&1 || true
    echo "Removed projects $PROJECT and $EDGE_PROJECT (containers, their volumes and networks). The git-ignored folder $ENV_DIR is left: delete it yourself when done."
    ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
