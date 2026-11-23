#!/usr/bin/env bash
# make-secrets.sh: fills random secrets, keeps them consistent across files, chmod 600, never prints them,
# refuses to overwrite real values without --force. Works in a temporary directory; touches nothing of yours.
source "$(dirname "$0")/lib.sh"

DIR="$(mktemp -d)"; CLEANUP_DIRS+=("$DIR")
export ENV_DIR="$DIR/env"
SCRIPT="$REPO/deploy/make-secrets.sh"
val() { grep -m1 "^$2=" "$ENV_DIR/$1.env" | cut -d= -f2-; }
mode() { stat -c %a "$1"; }

echo "first run"
OUT="$("$SCRIPT" 2>&1)"
for f in db app gateway; do expect_equal "$f.env is chmod 600" "600" "$(mode "$ENV_DIR/$f.env")"; done
expect_equal "the env folder is chmod 700" "700" "$(mode "$ENV_DIR")"
SUPER="$(val db POSTGRES_PASSWORD)"; GWPW="$(val db GATEWAY_DB_PASSWORD)"; APPPW="$(val db TRIAGEIQ_APP_DB_PASSWORD)"; REVIEW="$(val app REVIEW_API_KEY)"
expect_equal "the superuser password is 48 hex characters" "48" "${#SUPER}"
expect_equal "the review key is 64 hex characters" "64" "${#REVIEW}"
expect_equal "the three database passwords differ from each other" "3" "$(printf '%s\n' "$SUPER" "$GWPW" "$APPPW" | sort -u | wc -l | tr -d ' ')"
expect_equal "the gateway's review key equals the app's" "$REVIEW" "$(val gateway TRIAGE_REVIEW_API_KEY)"
expect_equal "DATABASE_URL carries the app role's password" "postgresql://triageiq_app:$APPPW@db:5432/triageiq" "$(val app DATABASE_URL)"
expect_equal "GATEWAY_DATABASE_URL carries the gateway role's password" "postgresql://gateway:$GWPW@db:5432/gateway" "$(val gateway GATEWAY_DATABASE_URL)"
for secret in "$SUPER" "$GWPW" "$APPPW" "$REVIEW"; do
  if printf '%s' "$OUT" | grep -qF "$secret"; then fail "a secret was PRINTED"; else pass "a secret was not printed"; fi
done
if printf '%s' "$OUT" | grep -q "ANTHROPIC_API_KEY in app.env"; then pass "it lists the keys you must fill by hand"; else fail "hand-fill list"; fi
expect_equal "ANTHROPIC_API_KEY is left as a placeholder" "REPLACE_ME_ANTHROPIC_API_KEY" "$(val app ANTHROPIC_API_KEY)"

echo "second run without --force"
"$SCRIPT" >/dev/null 2>&1
expect_equal "the superuser password is unchanged" "$SUPER" "$(val db POSTGRES_PASSWORD)"
expect_equal "the review key is unchanged" "$REVIEW" "$(val app REVIEW_API_KEY)"
expect_equal "DATABASE_URL is unchanged" "postgresql://triageiq_app:$APPPW@db:5432/triageiq" "$(val app DATABASE_URL)"

echo "a value you set by hand is kept; a missing gateway copy is repaired"
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=my-own-password/" "$ENV_DIR/db.env"
sed -i "s/^TRIAGE_REVIEW_API_KEY=.*/TRIAGE_REVIEW_API_KEY=REPLACE_ME_REVIEW_API_KEY/" "$ENV_DIR/gateway.env"
"$SCRIPT" >/dev/null 2>&1
expect_equal "your own password stays" "my-own-password" "$(val db POSTGRES_PASSWORD)"
expect_equal "the gateway's review key is copied from the app's again" "$REVIEW" "$(val gateway TRIAGE_REVIEW_API_KEY)"

echo "--force"
sed -i "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=sk-ant-mine/" "$ENV_DIR/app.env"
"$SCRIPT" --force >/dev/null 2>&1
expect_equal "the superuser password was replaced" "1" "$([ "$(val db POSTGRES_PASSWORD)" != my-own-password ] && echo 1 || echo 0)"
expect_equal "the gateway role password was replaced" "1" "$([ "$(val db GATEWAY_DB_PASSWORD)" != "$GWPW" ] && echo 1 || echo 0)"
expect_equal "the app role password was replaced" "1" "$([ "$(val db TRIAGEIQ_APP_DB_PASSWORD)" != "$APPPW" ] && echo 1 || echo 0)"
expect_equal "the review key changed" "1" "$([ "$(val app REVIEW_API_KEY)" != "$REVIEW" ] && echo 1 || echo 0)"
expect_equal "the gateway copy still equals the app's" "$(val app REVIEW_API_KEY)" "$(val gateway TRIAGE_REVIEW_API_KEY)"
expect_equal "the URLs follow the new passwords" "postgresql://triageiq_app:$(val db TRIAGEIQ_APP_DB_PASSWORD)@db:5432/triageiq" "$(val app DATABASE_URL)"
expect_equal "keys you typed by hand are not touched, even by --force" "sk-ant-mine" "$(val app ANTHROPIC_API_KEY)"
expect_equal "files are still chmod 600" "600" "$(mode "$ENV_DIR/app.env")"

echo "bad option"
expect_failure "an unknown option is refused" "$SCRIPT" --nope

finish
