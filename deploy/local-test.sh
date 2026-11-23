#!/usr/bin/env bash
# Runs the PRODUCTION stack on your own machine for a test, from this repository's source, with throwaway data.
# It is separate from your development stack: its own compose project, volumes and networks, fake provider keys, ports on 127.0.0.1 only.
#
#   deploy/local-test.sh up          build the three images, create deploy/env.local-test/ (git-ignored), start the stack
#   deploy/local-test.sh status      containers, health, memory
#   deploy/local-test.sh reviewer    create the test reviewer  tester@example.com / local-test-password-1234
#   deploy/local-test.sh down        stop it and DELETE its volumes and networks (only this project's)
#
# Then open https://localhost:8443 (a self-signed certificate: accept the browser warning once).
#   /            public form (Turnstile is OFF here: the production guard forbids Cloudflare's test secret)
#   /login       the reviewer login        /queue   the review queue (after logging in)
# Direct (no proxy): web http://127.0.0.1:8081   gateway http://127.0.0.1:3001
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${COMPOSE_PROJECT:-triageiq-local-test}"
export ENV_DIR="$HERE/env.local-test"
export TAG=local GHCR_OWNER=local
DC=(docker compose -p "$PROJECT" -f "$HERE/docker-compose.prod.yml" -f "$HERE/docker-compose.local-test.yml")

get() { { grep -m1 "^$2=" "$1" || true; } | cut -d= -f2-; }
put() { local f="$1" k="$2" v="$3" t; t="$(mktemp "$f.XXXXXX")"; KEYNAME="$k" NEWVALUE="$v" awk 'BEGIN{FS=OFS="=";k=ENVIRON["KEYNAME"];v=ENVIRON["NEWVALUE"]} $1==k&&!d{print k"="v;d=1;next}{print} END{if(!d)print k"="v}' "$f" > "$t"; chmod 600 "$t"; mv "$t" "$f"; }

prepare() {
  if [ -f "$ENV_DIR/.prepared" ]; then return; fi
  ENV_DIR="$ENV_DIR" "$HERE/make-secrets.sh" >/dev/null
  # Fake provider keys: no model call is ever made by this test. Obviously not real, and not a REPLACE_ME placeholder.
  put "$ENV_DIR/app.env" ANTHROPIC_API_KEY "sk-ant-local-test-not-a-real-key"
  put "$ENV_DIR/app.env" VOYAGE_API_KEY "pa-local-test-not-a-real-key"
  # The production guard really is on. These are the values a local run needs that it would also accept:
  put "$ENV_DIR/gateway.env" ALLOWED_ORIGINS "https://localhost:8443"
  put "$ENV_DIR/gateway.env" PUBLIC_FORM_ENABLED "false"     # the only Turnstile secrets that work locally are Cloudflare's TEST ones, which the guard refuses
  put "$ENV_DIR/gateway.env" MAIL_ENABLED "false"
  put "$ENV_DIR/gateway.env" TURNSTILE_SECRET_KEY ""          # unused while the form is off; a placeholder would be refused
  put "$ENV_DIR/gateway.env" TURNSTILE_EXPECTED_HOSTNAMES "localhost"
  # A real API client key, made with the real script in the real image.
  "${DC[@]}" build gateway >/dev/null
  out="$(docker run --rm "ghcr.io/local/triageiq-gateway:local" node scripts/make-client-key.ts local-submitter submitter)"
  entry="$(printf '%s\n' "$out" | grep -m1 '^  {')"
  put "$ENV_DIR/gateway.env" GATEWAY_CLIENTS "'[${entry#  }]'"
  touch "$ENV_DIR/.prepared"
  echo "prepared $ENV_DIR (git-ignored; throwaway secrets)"
}

case "${1:-}" in
  up)
    prepare
    "${DC[@]}" up -d --build
    echo; echo "Started project $PROJECT. Wait ~1 minute for health, then:  $0 status"
    ;;
  status)
    "${DC[@]}" ps
    echo; docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}' $("${DC[@]}" ps -q) 2>/dev/null || true
    ;;
  reviewer)
    printf '%s\n' "local-test-password-1234" | "${DC[@]}" exec -T gateway node dist/scripts/reviewers.js create --email tester@example.com --name "Local Tester"
    ;;
  logs) shift; "${DC[@]}" logs "$@" ;;
  down)
    "${DC[@]}" down -v --remove-orphans
    echo "Removed project $PROJECT (containers, its volumes and networks). The git-ignored folder $ENV_DIR is left: delete it yourself when done."
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
