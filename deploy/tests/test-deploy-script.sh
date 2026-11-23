#!/usr/bin/env bash
# deploy.sh with a FAKE docker (no Docker needed, nothing is started): env validation, tag validation, the previous-tag bookkeeping,
# rollback, refusing root, and stopping at the right step when something fails.
source "$(dirname "$0")/lib.sh"

W="$(mktemp -d)"; CLEANUP_DIRS+=("$W")
mkdir -p "$W/deploy" "$W/bin"
cp "$REPO/deploy/deploy.sh" "$REPO/deploy/make-secrets.sh" "$REPO/deploy/.env.example" "$W/deploy/"
mkdir -p "$W/deploy/env"; cp "$REPO/deploy/env/"*.example "$W/deploy/env/"
D="$W/deploy"; LOG="$W/docker.log"

# --- the fake docker ---------------------------------------------------------------------------------------------------------
cat > "$W/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  network) [ -z "${FAKE_NO_EDGE:-}" ]; exit $? ;;
  compose)
    shift
    [ "$1" = version ] && { echo "Docker Compose version v2.99"; exit 0; }
    here="$(dirname "$2")"; shift 2        # -f <file>
    tag="$(grep -m1 '^TAG=' "$here/.env" 2>/dev/null | cut -d= -f2)"
    echo "${TAG:-unset}" >> "$FAKE_LOG.tags"
    case "$1" in
      pull)  [ -z "${FAKE_PULL_FAIL:-}" ]; exit $? ;;
      up)    exit 0 ;;
      run)   [ -z "${FAKE_MIGRATE_FAIL:-}" ]; exit $? ;;
      exec)  [ -z "${FAKE_NOT_READY:-}" ]; exit $? ;;
      logs)  echo "gateway: some log line"; exit 0 ;;
      ps)    for s in app triageiq-gateway triageiq-web; do
               img="ghcr.io/obiomaikpe/triageiq-${s#triageiq-}:${FAKE_IMAGE_TAG:-$tag}"
               case "$*" in *Service*) echo "$s $img Up 5 seconds (healthy)" ;; *) echo "$img" ;; esac
             done; exit 0 ;;
    esac ;;
esac
exit 0
FAKE
chmod +x "$W/bin/docker"
cat > "$W/bin/id" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = "-u" ] && [ -n "${FAKE_ROOT:-}" ]; then echo 0; else exec /usr/bin/id "$@"; fi
FAKE
chmod +x "$W/bin/id"
export FAKE_LOG="$LOG" PATH="$W/bin:$PATH" DEPLOY_HEALTH_TIMEOUT=2 DEPLOY_HEALTH_INTERVAL=1
run() { (cd "$D" && ./deploy.sh "$@") ; }
state() { grep -m1 "^$1=" "$D/.deploy-state" 2>/dev/null | cut -d= -f2; }
fill() { # a complete, valid set of env files
  ENV_DIR="$D/env" "$D/make-secrets.sh" >/dev/null
  sed -i 's/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=sk-ant-real-looking-0123456789/; s/^VOYAGE_API_KEY=.*/VOYAGE_API_KEY=pa-real-looking-0123456789/' "$D/env/app.env"
  sed -i "s/^TURNSTILE_SECRET_KEY=.*/TURNSTILE_SECRET_KEY=0x4AAAAAAA-real-looking-secret/; s#^GATEWAY_CLIENTS=.*#GATEWAY_CLIENTS='[{\"name\":\"web-form\",\"role\":\"submitter\",\"key_sha256\":\"$(printf 'a%.0s' $(seq 64))\"}]'#" "$D/env/gateway.env"
}

echo "refusals before anything runs"
expect_failure "refuses to run as root" env FAKE_ROOT=1 bash -c "cd '$D' && ./deploy.sh sha-1a2b3c4"
expect_failure "no argument: usage, non-zero" run
expect_failure "env files missing: refused" run sha-1a2b3c4
expect_equal "and nothing was run against docker (only the compose-version probe)" "0" "$(touch "$LOG"; grep -cE 'pull|up -d|run --rm' "$LOG" || true)"
fill
cp -r "$D/env" "$W/env-good"
sed -i 's/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=REPLACE_ME_ANTHROPIC_API_KEY/' "$D/env/app.env"
expect_failure "a REPLACE_ME placeholder is refused" run sha-1a2b3c4
OUT="$(run sha-1a2b3c4 2>&1 || true)"
if printf '%s' "$OUT" | grep -q "placeholder still in app.env: ANTHROPIC_API_KEY"; then pass "it names the setting"; else fail "it names the setting"; fi
if printf '%s' "$OUT" | grep -q "REPLACE_ME_ANTHROPIC"; then fail "it must not print the value"; else pass "and does not print the value"; fi
cp "$W/env-good/"*.env "$D/env/"
sed -i 's/^GATEWAY_CLIENTS=.*/GATEWAY_CLIENTS='"'"'[{"name":"example-submitter","role":"submitter","key_sha256":"0000000000000000000000000000000000000000000000000000000000000000"}]'"'"'/' "$D/env/gateway.env"
expect_failure "the example client (all-zero hash) is refused" run sha-1a2b3c4
cp "$W/env-good/"*.env "$D/env/"
sed -i 's/^VOYAGE_API_KEY=.*/VOYAGE_API_KEY=/' "$D/env/app.env"
expect_failure "an EMPTY required value is refused" run sha-1a2b3c4
cp "$W/env-good/"*.env "$D/env/"
sed -i 's/^TRIAGE_REVIEW_API_KEY=.*/TRIAGE_REVIEW_API_KEY=something-else/' "$D/env/gateway.env"
expect_failure "review keys that differ between app.env and gateway.env are refused" run sha-1a2b3c4
cp "$W/env-good/"*.env "$D/env/"
sed -i 's/^DATABASE_URL=.*/DATABASE_URL=postgresql:\/\/triageiq_app:wrongpassword@db:5432\/triageiq/' "$D/env/app.env"
expect_failure "a DATABASE_URL whose password is not db.env's is refused" run sha-1a2b3c4
cp "$W/env-good/"*.env "$D/env/"
sed -i 's/^#\? *TURNSTILE_SECRET_KEY=.*/TURNSTILE_SECRET_KEY=/' "$D/env/gateway.env"
expect_failure "form enabled but no Turnstile secret is refused" run sha-1a2b3c4
cp "$W/env-good/"*.env "$D/env/"
for bad in latest v1 sha-123 sha-ZZZZZZZ sha-1a2b3c4d "sha-1a2b3c4;ls"; do
  expect_failure "tag '$bad' is refused" run "$bad"
done
FAKE_NO_EDGE=1 expect_failure "a missing edge network is refused" run sha-1a2b3c4

echo "first deploy"
: > "$LOG"
expect_success "deploys sha-1111111" run sha-1111111
expect_equal ".env now says the tag" "sha-1111111" "$(grep '^TAG=' "$D/.env" | cut -d= -f2)"
expect_equal "current is recorded" "sha-1111111" "$(state CURRENT_TAG)"
expect_equal "previous is empty on a first deploy" "" "$(state PREVIOUS_TAG)"
expect_equal ".env is chmod 600" "600" "$(stat -c %a "$D/.env")"
expect_equal "the steps ran in order: pull, db+redis, migrate, up, health" "pull|up -d --wait db redis|run --rm gateway-migrate|up -d --remove-orphans|exec -T triageiq-gateway" "$(grep -E 'pull|up -d|run --rm|exec -T' "$LOG" | sed -E 's/^network.*//; s/^compose -f [^ ]+ //; s/ node -e.*//' | grep . | paste -sd'|')"
OUT="$(run sha-1111111 2>&1)"
if printf '%s' "$OUT" | grep -q "Running TAG: sha-1111111"; then pass "it prints the running tag"; else fail "it prints the running tag"; fi
expect_equal "redeploying the SAME tag does not overwrite 'previous'" "" "$(state PREVIOUS_TAG)"
expect_failure "rollback with no previous refuses" run --rollback

echo "second deploy and rollback"
expect_success "deploys sha-2222222" run sha-2222222
expect_equal "previous is the first tag" "sha-1111111" "$(state PREVIOUS_TAG)"
expect_equal "current is the new one" "sha-2222222" "$(state CURRENT_TAG)"
: > "$LOG"
expect_success "rollback works" run --rollback
expect_equal "the rollback pulled the OLD tag's images" "sha-1111111" "$(grep '^TAG=' "$D/.env" | cut -d= -f2)"
expect_equal "current is the old tag again" "sha-1111111" "$(state CURRENT_TAG)"
expect_equal "and 'previous' is now the one we left" "sha-2222222" "$(state PREVIOUS_TAG)"
expect_success "rolling back twice returns to the newer one" run --rollback
expect_equal "current after the second rollback" "sha-2222222" "$(state CURRENT_TAG)"
expect_success "a third deploy records the right previous" run sha-3333333
expect_equal "previous" "sha-2222222" "$(state PREVIOUS_TAG)"
expect_equal "--status prints both" "running:  sha-3333333 previous: sha-2222222" "$(run --status | paste -sd' ')"
expect_equal "main is accepted as a tag" "0" "$(run main >/dev/null 2>&1; echo $?)"
expect_equal "and recorded" "main" "$(state CURRENT_TAG)"

echo "failures stop at the right step and say so"
run sha-4444444 >/dev/null 2>&1
: > "$LOG"
FAKE_PULL_FAIL=1 expect_failure "a failed pull stops the deploy" run sha-5555555
expect_equal "nothing was started after the failed pull" "0" "$(grep -cE 'up -d|run --rm' "$LOG" || true)"
OUT="$(FAKE_PULL_FAIL=1 run sha-5555555 2>&1 || true)"
if printf '%s' "$OUT" | grep -q "pull failed for tag sha-5555555"; then pass "the message says the pull failed"; else fail "pull failure message"; fi
: > "$LOG"
FAKE_MIGRATE_FAIL=1 expect_failure "a failed migration stops the deploy" run sha-6666666
expect_equal "the stack was not started after a failed migration" "0" "$(grep -c 'up -d --remove-orphans' "$LOG" || true)"
FAKE_NOT_READY=1 expect_failure "a stack that never becomes ready is reported as a failure" run sha-7777777
OUT="$(FAKE_NOT_READY=1 run sha-7777777 2>&1 || true)"
if printf '%s' "$OUT" | grep -q "is NOT healthy on sha-7777777" && printf '%s' "$OUT" | grep -q -- "--rollback"; then pass "it says so and points at --rollback"; else fail "unhealthy message"; fi
expect_equal "an unhealthy deploy is still recorded, so --rollback can undo it" "sha-7777777" "$(state CURRENT_TAG)"
FAKE_IMAGE_TAG=sha-9999999 expect_failure "images that do not carry the requested tag are caught" run sha-8888888

echo "a stale TAG exported in the shell must not win over the one being deployed"
: > "$LOG.tags"
TAG=sha-0000001 run sha-2121212 >/dev/null 2>&1
expect_equal "every docker call saw the NEW tag" "sha-2121212" "$(sort -u "$LOG.tags" | grep -v '^unset$' | paste -sd' ')"

echo "nothing secret is printed"
OUT="$(run sha-1010101 2>&1 || true)"
SECRET="$(grep -m1 '^REVIEW_API_KEY=' "$D/env/app.env" | cut -d= -f2)"
if printf '%s' "$OUT" | grep -qF "$SECRET"; then fail "the review key appeared in the output"; else pass "the review key never appears in the output"; fi
finish
