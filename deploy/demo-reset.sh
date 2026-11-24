#!/usr/bin/env bash
# The nightly demo reset (systemd runs it at 04:00, after the 03:30 backup). Run by hand any time:  ./demo-reset.sh
#
#   1. python -m app.demo.reset      deletes EVERY demo ticket and its checkpoints, then puts the example tickets back
#                                    (only rows with is_demo = true: a real ticket is never selected). One transaction.
#   2. demo-sessions end             ends every session of the shared demo user (Redis), so nobody keeps a page open on tickets
#                                    that no longer exist.
# Exits non-zero if either step fails (systemd then marks the run failed), and stops at the first failure.
# Not touched, by design: ticket references a visitor's test ticket reserved in the gateway database (a few bytes each, never reused,
# so nothing can collide) and the queue's own finished jobs (they expire by themselves).
#
# Settings: COMPOSE_FILE (default docker-compose.prod.yml next to this script), TIQ_DC (the whole compose command, for tests).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${TIQ_DC:-}" ]; then
  read -r -a DC <<<"$TIQ_DC"
else
  export TAG="${TAG:-demo-reset}"   # the compose file insists on a TAG when it is read; `exec` does not use it
  DC=(docker compose -f "${COMPOSE_FILE:-$HERE/docker-compose.prod.yml}")
fi

log() { echo "$(date '+%F %T') demo-reset: $*"; }

log "resetting the demo tickets"
"${DC[@]}" exec -T app python -m app.demo.reset || { log "FAILED: the ticket reset failed (the demo room is as it was)" >&2; exit 1; }
log "ending the demo visitors' sessions"
"${DC[@]}" exec -T triageiq-gateway node dist/scripts/demo-sessions.js end || { log "FAILED: the tickets were reset but the sessions could not be ended" >&2; exit 1; }
log "done"
