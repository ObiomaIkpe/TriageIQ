#!/usr/bin/env bash
# Creates deploy/env/{db,app,gateway}.env from the *.example files (if they do not exist yet) and fills in fresh RANDOM secrets:
#   db.env      POSTGRES_PASSWORD, GATEWAY_DB_PASSWORD, TRIAGEIQ_APP_DB_PASSWORD
#   app.env     REVIEW_API_KEY, and the password inside DATABASE_URL
#   gateway.env TRIAGE_REVIEW_API_KEY (the same value as REVIEW_API_KEY), and the password inside GATEWAY_DATABASE_URL
# It NEVER prints a secret and never puts one on a command line. It only says which names it set. Files are chmod 600.
#
# It will NOT overwrite a secret that already has a real value. To replace them all with new ones: --force
# (then the databases must be told the new passwords, see README "Rotating secrets").
#
# It does NOT create the provider keys (ANTHROPIC_API_KEY, VOYAGE_API_KEY), the Turnstile secret or the API client keys:
# those come from other people's systems or from make-client-key. Edit them into the files by hand.
#
#   ./make-secrets.sh [--force]        ENV_DIR=/some/dir ./make-secrets.sh   (default: deploy/env)
set -euo pipefail
umask 077

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (use --force or --help)" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_DIR="${ENV_DIR:-$HERE/env}"
mkdir -p "$ENV_DIR"; chmod 700 "$ENV_DIR"

command -v openssl >/dev/null || { echo "openssl is needed to make random secrets" >&2; exit 1; }

for name in db app gateway; do
  target="$ENV_DIR/$name.env"
  if [ ! -e "$target" ]; then
    cp "$HERE/env/$name.env.example" "$target"
    echo "created $target from $name.env.example"
  fi
  chmod 600 "$target"
done

# --- helpers (values travel in the environment of awk, never in a command line) ---------------------------------------
get() { # get <file> <key>: the value, or empty
  { grep -m1 "^$2=" "$1" || true; } | cut -d= -f2-
}
is_placeholder() { [ -z "$1" ] || printf '%s' "$1" | grep -qiE 'replace[-_ ]?(me|with)'; }
set_value() { # set_value <file> <key> <value>: replaces the line, or adds it
  local file="$1" tmp
  tmp="$(mktemp "$file.XXXXXX")"
  KEYNAME="$2" NEWVALUE="$3" awk 'BEGIN { FS = OFS = "="; k = ENVIRON["KEYNAME"]; v = ENVIRON["NEWVALUE"] }
    $1 == k && !done { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$file" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$file"
}
random() { openssl rand -hex "$1"; }   # hex: letters and digits only, so it is safe inside a URL

DB="$ENV_DIR/db.env" APP="$ENV_DIR/app.env" GW="$ENV_DIR/gateway.env"

# --- 1. the four secrets: keep a real existing value, otherwise make a new one ------------------------------------------
resolve() { # resolve <file> <key> <bytes> -> sets REPLY and CHANGED
  local current; current="$(get "$1" "$2")"
  if [ "$FORCE" = 0 ] && ! is_placeholder "$current"; then REPLY="$current"; CHANGED=0
  else REPLY="$(random "$3")"; CHANGED=1; fi
}
resolve "$DB" POSTGRES_PASSWORD 24;           PW_SUPER="$REPLY"; C_SUPER=$CHANGED
resolve "$DB" GATEWAY_DB_PASSWORD 24;         PW_GW="$REPLY";    C_GW=$CHANGED
resolve "$DB" TRIAGEIQ_APP_DB_PASSWORD 24;    PW_APP="$REPLY";   C_APP=$CHANGED
resolve "$APP" REVIEW_API_KEY 32;             REVIEW="$REPLY";   C_REVIEW=$CHANGED
# The gateway's copy of the review key must equal the app's. If only the gateway's is missing, copy the app's.
if [ "$C_REVIEW" = 0 ]; then gw_review="$(get "$GW" TRIAGE_REVIEW_API_KEY)"; if is_placeholder "$gw_review" || [ "$gw_review" != "$REVIEW" ]; then C_REVIEW_GW=1; else C_REVIEW_GW=0; fi; else C_REVIEW_GW=1; fi

say() { echo "  $1 in $2: $3"; }
[ "$C_SUPER" = 1 ] && { set_value "$DB" POSTGRES_PASSWORD "$PW_SUPER"; say POSTGRES_PASSWORD db.env "new random value"; } || say POSTGRES_PASSWORD db.env "kept (already set)"
[ "$C_GW" = 1 ]    && { set_value "$DB" GATEWAY_DB_PASSWORD "$PW_GW"; say GATEWAY_DB_PASSWORD db.env "new random value"; } || say GATEWAY_DB_PASSWORD db.env "kept (already set)"
[ "$C_APP" = 1 ]   && { set_value "$DB" TRIAGEIQ_APP_DB_PASSWORD "$PW_APP"; say TRIAGEIQ_APP_DB_PASSWORD db.env "new random value"; } || say TRIAGEIQ_APP_DB_PASSWORD db.env "kept (already set)"
[ "$C_REVIEW" = 1 ] && { set_value "$APP" REVIEW_API_KEY "$REVIEW"; say REVIEW_API_KEY app.env "new random value"; } || say REVIEW_API_KEY app.env "kept (already set)"
[ "$C_REVIEW_GW" = 1 ] && { set_value "$GW" TRIAGE_REVIEW_API_KEY "$REVIEW"; say TRIAGE_REVIEW_API_KEY gateway.env "set to the same value as REVIEW_API_KEY"; } || say TRIAGE_REVIEW_API_KEY gateway.env "kept (already equal)"

# --- 2. the two database URLs carry the role passwords: rewrite them whenever they differ or are placeholders ------------
want_app="postgresql://triageiq_app:${PW_APP}@db:5432/triageiq"
want_gw="postgresql://gateway:${PW_GW}@db:5432/gateway"
[ "$(get "$APP" DATABASE_URL)" = "$want_app" ] && say DATABASE_URL app.env "kept (matches db.env)" || { set_value "$APP" DATABASE_URL "$want_app"; say DATABASE_URL app.env "written (matches db.env)"; }
[ "$(get "$GW" GATEWAY_DATABASE_URL)" = "$want_gw" ] && say GATEWAY_DATABASE_URL gateway.env "kept (matches db.env)" || { set_value "$GW" GATEWAY_DATABASE_URL "$want_gw"; say GATEWAY_DATABASE_URL gateway.env "written (matches db.env)"; }

chmod 600 "$DB" "$APP" "$GW"
echo
echo "Still to fill in BY HAND (make-secrets cannot know them):"
for pair in "app.env:ANTHROPIC_API_KEY" "app.env:VOYAGE_API_KEY" "gateway.env:TURNSTILE_SECRET_KEY" "gateway.env:GATEWAY_CLIENTS"; do
  f="${pair%%:*}"; k="${pair##*:}"
  v="$(get "$ENV_DIR/$f" "$k")"
  if is_placeholder "$v" || printf '%s' "$v" | grep -q '0000000000000000000000000000000000000000000000000000000000000000'; then echo "  $k in $f"; fi
done
echo "Changing a database password in the env files does NOT change it inside an existing database: see README, Rotating secrets."
