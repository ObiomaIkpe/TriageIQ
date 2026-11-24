#!/usr/bin/env bash
# demo-reset.sh with a fake docker compose: the two steps run in order, a failure stops it and exits non-zero, and the systemd timer is 04:00.
source "$(dirname "$0")/lib.sh"
W="$(mktemp -d)"; CLEANUP_DIRS+=("$W")
LOG="$W/log"; FAKE="$W/fake-dc"
cat > "$FAKE" <<'F'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *"app python -m app.demo.reset"*) [ -z "${FAIL_RESET:-}" ] ;;
  *"demo-sessions.js end"*) [ -z "${FAIL_SESSIONS:-}" ] ;;
esac
F
chmod +x "$FAKE"
export FAKE_LOG="$LOG" TIQ_DC="$FAKE"
SCRIPT="$REPO/deploy/demo-reset.sh"

: > "$LOG"
expect_success "a normal run succeeds" "$SCRIPT"
expect_equal "it resets the tickets FIRST, then ends the sessions, and nothing else" "exec -T app python -m app.demo.reset|exec -T triageiq-gateway node dist/scripts/demo-sessions.js end" "$(paste -sd'|' "$LOG")"
: > "$LOG"
FAIL_RESET=1 expect_failure "a failed ticket reset exits non-zero" "$SCRIPT"
expect_equal "and the sessions are NOT ended after it" "exec -T app python -m app.demo.reset" "$(paste -sd'|' "$LOG")"
FAIL_SESSIONS=1 expect_failure "a failed session step exits non-zero (after the reset ran)" "$SCRIPT"

expect_equal "the timer runs at 04:00" "OnCalendar=*-*-* 04:00:00" "$(grep '^OnCalendar' "$REPO/deploy/systemd/triageiq-demo-reset.timer")"
expect_equal "the backup timer is at 03:30 (so the reset comes after it)" "OnCalendar=*-*-* 03:30:00" "$(grep '^OnCalendar' "$REPO/deploy/systemd/triageiq-backup.timer")"
expect_equal "the service runs the script" "ExecStart=/opt/triageiq/deploy/demo-reset.sh" "$(grep '^ExecStart' "$REPO/deploy/systemd/triageiq-demo-reset.service")"
finish
