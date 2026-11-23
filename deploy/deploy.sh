#!/usr/bin/env bash
# Deploys one version of TriageIQ on the server, and can go back to the one before.
#
#   cd /opt/triageiq/deploy
#   ./deploy.sh sha-1a2b3c4          deploy exactly that image tag (what CI published for a commit on main)
#   ./deploy.sh main                 deploy whatever "main" points at right now (allowed, but a sha tag is better: it is exact)
#   ./deploy.sh --rollback           go back to the tag that was running before the last deploy
#   ./deploy.sh --status             print the running tag and the previous one; changes nothing
#
# What a deploy does, in order (it stops at the first failure and says which step):
#   1. refuses to run as root; checks the env files exist, hold no placeholder and no empty required value; checks the "edge" network;
#   2. records the tag that was running as the PREVIOUS one (.deploy-state, next to this script), and writes the new tag into .env;
#   3. pulls the three images for the tag;
#   4. starts db and redis, runs the gateway's database migrations (one-shot gateway-migrate);
#   5. starts everything (the python app runs its own migrations when it starts);
#   6. waits until the gateway's /ready (Redis and the python service both answering) says yes, asking from INSIDE the gateway container;
#   7. prints the tag every service is running.
# Database migrations are not undone by a rollback (only the images change): see deploy/README.md, "Roll back".
#
# Test hooks: DEPLOY_HEALTH_TIMEOUT (seconds, default 180), DEPLOY_HEALTH_INTERVAL (seconds, default 5).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_DIR="${ENV_DIR:-$HERE/env}"
STATE="$HERE/.deploy-state"
ENVFILE="$HERE/.env"
HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-180}"
HEALTH_INTERVAL="${DEPLOY_HEALTH_INTERVAL:-5}"
GATEWAY=triageiq-gateway

die()  { echo "deploy: ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }
dc()   { docker compose -f "$HERE/docker-compose.prod.yml" "$@"; }
get()  { { grep -m1 "^$2=" "$1" 2>/dev/null || true; } | cut -d= -f2-; }
put()  { # put <file> <key> <value>: replace the line or add it, without ever putting the value on a command line
  local f="$1" t; touch "$f"; t="$(mktemp "$f.XXXXXX")"
  KEYNAME="$2" NEWVALUE="$3" awk 'BEGIN{FS=OFS="=";k=ENVIRON["KEYNAME"];v=ENVIRON["NEWVALUE"]} $1==k&&!d{print k"="v;d=1;next}{print} END{if(!d)print k"="v}' "$f" > "$t"
  chmod 600 "$t"; mv "$t" "$f"
}

# ---- arguments -----------------------------------------------------------------------------------------------------------------
MODE=deploy; TARGET=""
case "${1:-}" in
  --rollback) MODE=rollback ;;
  --status)   MODE=status ;;
  -h|--help|"") sed -n '2,21p' "$0"; [ -n "${1:-}" ] && exit 0 || exit 2 ;;
  -*) die "unknown option $1" ;;
  *) TARGET="$1" ;;
esac
[ "$#" -le 1 ] || die "too many arguments"

# ---- refuse root ---------------------------------------------------------------------------------------------------------------
[ "$(id -u)" != 0 ] || die "do not run this as root or with sudo: run it as the deploy user (a member of the docker group). Root-owned files in deploy/ would break the next deploy."

state_get() { get "$STATE" "$1"; }
state_set() { put "$STATE" CURRENT_TAG "$1"; put "$STATE" PREVIOUS_TAG "$2"; }

if [ "$MODE" = status ]; then
  echo "running:  ${CURRENT:-$(state_get CURRENT_TAG)}"; echo "previous: $(state_get PREVIOUS_TAG)"
  exit 0
fi

# ---- 1. validation --------------------------------------------------------------------------------------------------------------
validate_tag() {
  case "$1" in
    main) return 0 ;;
    sha-*) printf '%s' "$1" | grep -Eq '^sha-[0-9a-f]{7}$' ;;
    *) return 1 ;;
  esac
}

# A value is a placeholder if it is empty or carries one of the markers the .example files use.
is_placeholder() { [ -z "$1" ] || printf '%s' "$1" | grep -qiE 'replace[-_ ]?(me|with)|0{64}'; }

validate_env() {
  local problems=0 f name key value
  for name in db app gateway; do
    f="$ENV_DIR/$name.env"
    if [ ! -f "$f" ]; then echo "  missing: $f   (run ./make-secrets.sh)" >&2; problems=$((problems + 1)); continue; fi
    if [ "$(stat -c %a "$f")" != 600 ]; then echo "  warning: $f is not chmod 600 (run: chmod 600 $f)" >&2; fi
    # No placeholder ANYWHERE in an active (not commented) line.
    while IFS= read -r line; do
      key="${line%%=*}"; value="${line#*=}"
      if is_placeholder "$value" && [ -n "$value" ]; then echo "  placeholder still in $name.env: $key" >&2; problems=$((problems + 1)); fi
    done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$f" || true)
  done
  # Values that must exist and be non-empty.
  for pair in db:POSTGRES_USER db:POSTGRES_PASSWORD db:GATEWAY_DB_PASSWORD db:TRIAGEIQ_APP_DB_PASSWORD \
              app:ANTHROPIC_API_KEY app:VOYAGE_API_KEY app:REVIEW_API_KEY app:DATABASE_URL app:APP_ENV \
              gateway:TRIAGE_REVIEW_API_KEY gateway:GATEWAY_DATABASE_URL gateway:GATEWAY_CLIENTS gateway:ALLOWED_ORIGINS; do
    name="${pair%%:*}"; key="${pair##*:}"; f="$ENV_DIR/$name.env"
    [ -f "$f" ] || continue
    if [ -z "$(get "$f" "$key")" ]; then echo "  empty or missing in $name.env: $key" >&2; problems=$((problems + 1)); fi
  done
  if [ -f "$ENV_DIR/gateway.env" ] && [ "$(get "$ENV_DIR/gateway.env" PUBLIC_FORM_ENABLED)" = true ] && [ -z "$(get "$ENV_DIR/gateway.env" TURNSTILE_SECRET_KEY)" ]; then
    echo "  empty or missing in gateway.env: TURNSTILE_SECRET_KEY (PUBLIC_FORM_ENABLED is true)" >&2; problems=$((problems + 1))
  fi
  # The two copies of the review key must agree, and the database URLs must carry the db.env passwords.
  if [ -f "$ENV_DIR/app.env" ] && [ -f "$ENV_DIR/gateway.env" ] && [ "$(get "$ENV_DIR/app.env" REVIEW_API_KEY)" != "$(get "$ENV_DIR/gateway.env" TRIAGE_REVIEW_API_KEY)" ]; then
    echo "  REVIEW_API_KEY (app.env) and TRIAGE_REVIEW_API_KEY (gateway.env) differ" >&2; problems=$((problems + 1))
  fi
  if [ -f "$ENV_DIR/db.env" ] && [ -f "$ENV_DIR/app.env" ]; then
    case "$(get "$ENV_DIR/app.env" DATABASE_URL)" in *":$(get "$ENV_DIR/db.env" TRIAGEIQ_APP_DB_PASSWORD)@"*) ;; *) echo "  DATABASE_URL (app.env) does not carry TRIAGEIQ_APP_DB_PASSWORD (db.env)" >&2; problems=$((problems + 1)) ;; esac
  fi
  if [ -f "$ENV_DIR/db.env" ] && [ -f "$ENV_DIR/gateway.env" ]; then
    case "$(get "$ENV_DIR/gateway.env" GATEWAY_DATABASE_URL)" in *":$(get "$ENV_DIR/db.env" GATEWAY_DB_PASSWORD)@"*) ;; *) echo "  GATEWAY_DATABASE_URL (gateway.env) does not carry GATEWAY_DB_PASSWORD (db.env)" >&2; problems=$((problems + 1)) ;; esac
  fi
  [ "$problems" = 0 ] || die "$problems problem(s) in the env files (names only are shown, never values). Fix them with nano and run again."
}

command -v docker >/dev/null 2>&1 || die "docker is not installed (run server/setup.sh first)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed (run server/setup.sh first)"

CURRENT="$(state_get CURRENT_TAG)"; PREVIOUS="$(state_get PREVIOUS_TAG)"
if [ "$MODE" = rollback ]; then
  [ -n "$PREVIOUS" ] || die "there is no previous tag on record (.deploy-state): nothing to roll back to"
  TARGET="$PREVIOUS"
fi
validate_tag "$TARGET" || die "the tag must look like sha-<7 hex characters> (for example sha-1a2b3c4) or be 'main' (got: $TARGET)"

step "1/7 checking the env files and the edge network"
validate_env
echo "  env files are complete, with no placeholder."
docker network inspect "${EDGE_NETWORK:-edge}" >/dev/null 2>&1 || die "the Docker network \"${EDGE_NETWORK:-edge}\" does not exist (sudo server/setup.sh creates it; the edge stack must be running too)"

# ---- 2. bookkeeping ------------------------------------------------------------------------------------------------------------
step "2/7 tag: ${CURRENT:-none} -> $TARGET"
if [ "$MODE" = rollback ]; then
  NEW_PREVIOUS="$CURRENT"                      # rolling back again would return to the version we just left
elif [ "$TARGET" = "$CURRENT" ]; then
  NEW_PREVIOUS="$PREVIOUS"                     # redeploying the running tag must not overwrite the previous one
else
  NEW_PREVIOUS="$CURRENT"
fi
[ -f "$ENVFILE" ] || cp "$HERE/.env.example" "$ENVFILE"
put "$ENVFILE" TAG "$TARGET"
export TAG="$TARGET"     # compose prefers the environment over .env: a stale TAG exported in your shell must never win
chmod 600 "$ENVFILE"
state_set "$TARGET" "$NEW_PREVIOUS"

# ---- 3-5. pull, migrate, start ------------------------------------------------------------------------------------------------------
step "3/7 pulling the images for $TARGET"
dc pull || die "pull failed for tag $TARGET (does that tag exist? are the packages public?). The running containers were not touched; .env now says TAG=$TARGET, so run ./deploy.sh ${CURRENT:-<tag>} to put it back."

step "4/7 database and queue up, then the gateway's migrations"
dc up -d --wait db redis || die "db/redis did not become healthy: docker compose -f docker-compose.prod.yml logs db redis"
dc run --rm gateway-migrate || die "the gateway migration failed (nothing else was restarted): docker compose -f docker-compose.prod.yml logs gateway-migrate"

step "5/7 starting the stack"
dc up -d --remove-orphans || die "docker compose up failed: docker compose -f docker-compose.prod.yml ps; logs <service>"

# ---- 6. health ----------------------------------------------------------------------------------------------------------------------------
step "6/7 waiting for $GATEWAY /ready (up to ${HEALTH_TIMEOUT}s)"
waited=0
until dc exec -T "$GATEWAY" node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
    echo "  not ready after ${HEALTH_TIMEOUT}s. Recent gateway and app logs:" >&2
    dc logs --tail 15 "$GATEWAY" app >&2 || true
    die "the stack is NOT healthy on $TARGET. If a guard refused to start, the log above names the setting. To go back: ./deploy.sh --rollback"
  fi
  sleep "$HEALTH_INTERVAL"; waited=$((waited + HEALTH_INTERVAL))
done
echo "  ready after about ${waited}s."

# ---- 7. what is running -----------------------------------------------------------------------------------------------------------------
step "7/7 running"
dc ps --format '{{.Service}} {{.Image}} {{.Status}}' | sed 's/^/  /'
RUNNING="$(dc ps --format '{{.Image}}' | sed -n 's#^ghcr.io/.*/triageiq-[a-z]*:##p' | sort -u | tr '\n' ' ' | sed 's/ $//')"
echo
echo "Running TAG: $RUNNING"
echo "Previous TAG: ${NEW_PREVIOUS:-none}   (./deploy.sh --rollback returns to it)"
[ "$RUNNING" = "$TARGET" ] || die "the running images carry tag(s) '$RUNNING', not $TARGET"
