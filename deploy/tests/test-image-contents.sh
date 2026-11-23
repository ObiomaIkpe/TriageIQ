#!/usr/bin/env bash
# No image may contain an env file, a private key, a database dump or a provider key, and none may carry a secret in its
# build metadata (ENV, ARG, history).   deploy/tests/test-image-contents.sh <app-image> <gateway-image> <web-image>
source "$(dirname "$0")/lib.sh"
[ "$#" -eq 3 ] || { echo "usage: $0 <app-image> <gateway-image> <web-image>" >&2; exit 2; }

scan() { # scan <label> <image>
  local label="$1" image="$2" found
  echo "$label ($image)"
  found="$(docker run --rm --entrypoint sh "$image" -c 'find / -xdev \( -name ".env" -o -name ".env.*" -o -name "*.env" -o -name "id_rsa*" -o -name "id_ed25519*" -o -name "*.dump" -o -name "*.sql" -o -name ".npmrc" -o -name ".netrc" -o -name "credentials*" -o -name ".git" -o -name "*_backup.sql" \) -not -path "/proc/*" -not -path "*/node_modules/*" -not -path "*/site-packages/*" 2>/dev/null' || true)"
  # *.sql files that belong to the app on purpose (the gateway's migrations) are allowed; nothing else is.
  found="$(printf '%s\n' "$found" | grep -v '^/app/migrations/[0-9]*_.*\.sql$' | grep -v '^$' || true)"
  expect_equal "no env file, key file, dump or credentials file" "" "$found"
  expect_equal "no PEM private key block in the application files (README examples in dependencies are not keys)" "0" "$(docker run --rm --entrypoint sh "$image" -c 'grep -rIl --exclude=*.md -e "BEGIN [A-Z ]*PRIVATE KEY" /app /usr/share/nginx/html 2>/dev/null | wc -l')"
  expect_equal "no Anthropic or Voyage key shape anywhere in the image" "0" "$(docker run --rm --entrypoint sh "$image" -c 'grep -rIlE --exclude=RECORD --exclude=*.md -e "sk-ant-[A-Za-z0-9_-]{20,}" -e "(^|[^A-Za-z0-9_-])pa-[A-Za-z0-9_]{30,}" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | wc -l')"
  expect_equal "no secret-looking name in the image's ENV (GPG_KEY of the python base image is a PUBLIC key id)" "0" "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image" | grep -iE '(KEY|SECRET|PASSWORD|TOKEN|PASS)=' | grep -vE '^GPG_KEY=' | wc -l)"
  expect_equal "no secret-looking value in the build history" "0" "$(docker history --no-trunc --format '{{.CreatedBy}}' "$image" | grep -ciE '(API_KEY|SECRET|PASSWORD|TOKEN)=' || true)"
}
scan "app image" "$1"
scan "gateway image" "$2"
scan "web image" "$3"
echo "what is in each image's application folder"
echo "  app:     $(docker run --rm --entrypoint sh "$1" -c 'ls /app | tr "\n" " "')"
echo "  gateway: $(docker run --rm --entrypoint sh "$2" -c 'ls /app | tr "\n" " "')"
echo "  web:     $(docker run --rm --entrypoint sh "$3" -c 'ls /usr/share/nginx/html | tr "\n" " "')"
finish
