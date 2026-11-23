#!/usr/bin/env bash
# The web image: runs as non-root, serves the SPA with a fallback, caches hashed assets for long and index.html not at all,
# and sends the security headers (CSP with only self + Turnstile, no inline script) on EVERY response, errors included.
#   deploy/tests/test-web-image.sh [image]      (default: builds triageiq-web:test from ./web)
source "$(dirname "$0")/lib.sh"

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  IMAGE=triageiq-web:test
  docker build -q --build-arg VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA -t "$IMAGE" "$REPO/web" >/dev/null
fi
NAME="tiq-web-test-$RUN_ID"; CLEANUP_CONTAINERS+=("$NAME")
docker run -d --name "$NAME" -p 127.0.0.1::8080 --read-only --tmpfs /tmp --cap-drop ALL "$IMAGE" >/dev/null
PORT="$(docker port "$NAME" 8080/tcp | head -1 | sed 's/.*://')"
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
URL="http://127.0.0.1:$PORT"

header() { curl -sS -D - -o /dev/null "$URL$1" | tr -d '\r' | grep -i "^$2:" | head -1 | cut -d: -f2- | sed 's/^ //'; }
status() { curl -sS -o /dev/null -w '%{http_code}' "$URL$1"; }

echo "container"
expect_equal "runs as a non-root user (not uid 0)" "uid=101(nginx)" "$(docker exec "$NAME" id | cut -d' ' -f1)"
expect_equal "runs fine with a read-only filesystem and no capabilities" "ok" "$(curl -sS "$URL/healthz" | tr -d '\n')"
expect_equal "docker's own health check reports healthy" "healthy" "$(for i in $(seq 1 40); do s=$(docker inspect -f '{{.State.Health.Status}}' "$NAME"); [ "$s" = healthy ] && break; sleep 1; done; echo "$s")"

echo "single-page app"
expect_equal "/ is the app" "200" "$(status /)"
expect_equal "/login (a client route) falls back to index.html" "200" "$(status /login)"
expect_equal "/queue falls back to index.html" "200" "$(status /queue)"
expect_equal "a deep client route falls back too" "200" "$(status '/queue/anything/deep?ticket=TKT-ABC234')"
if curl -sS "$URL/login" | grep -q '<div id="root">'; then pass "the fallback is the app's index.html"; else fail "the fallback is the app's index.html"; fi
expect_equal "a missing asset is a real 404, never index.html" "404" "$(status /assets/does-not-exist.js)"

echo "caching"
ASSET="$(curl -sS "$URL/" | grep -o '/assets/[^"]*\.js' | head -1)"
[ -n "$ASSET" ] && pass "index.html names a hashed asset ($ASSET)" || fail "no asset found in index.html"
expect_equal "hashed assets are cached for a year and immutable" "public, max-age=31536000, immutable" "$(header "$ASSET" cache-control)"
expect_equal "index.html is never cached" "no-cache" "$(header / cache-control)"
expect_equal "index.html by name is never cached" "no-cache" "$(header /index.html cache-control)"
expect_equal "a client route is not cached either" "no-cache" "$(header /queue cache-control)"

echo "security headers on EVERY kind of response"
CSP="default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
for path in / /login /index.html "$ASSET" /healthz /assets/does-not-exist.js /favicon.ico; do
  expect_equal "CSP on $path" "$CSP" "$(header "$path" content-security-policy)"
  expect_equal "X-Content-Type-Options on $path" "nosniff" "$(header "$path" x-content-type-options)"
  expect_equal "Referrer-Policy on $path" "strict-origin-when-cross-origin" "$(header "$path" referrer-policy)"
  expect_equal "X-Frame-Options on $path" "DENY" "$(header "$path" x-frame-options)"
done
# a malformed request line is answered by nginx itself (400) - also with the headers? (only checked where nginx can: bad Host is fine)
expect_equal "a 405 (POST to a static file) also has the CSP" "$CSP" "$(curl -sS -X POST -D - -o /dev/null "$URL/index.html" | tr -d '\r' | grep -i '^content-security-policy:' | cut -d: -f2- | sed 's/^ //')"
case "$CSP" in *"script-src 'self' https://challenges.cloudflare.com;"*) pass "script-src is self + challenges.cloudflare.com only";; *) fail "script-src";; esac
case "$CSP" in *unsafe-inline*|*unsafe-eval*) fail "the CSP must not allow unsafe-inline or unsafe-eval";; *) pass "no unsafe-inline, no unsafe-eval";; esac
expect_equal "the server does not announce its version" "nginx" "$(header / server)"

echo "the built page has no inline script (CSP would block it)"
expect_equal "index.html has no <script> without src" "0" "$(curl -sS "$URL/" | grep -Eo '<script[^>]*>' | grep -vc 'src=' || true)"
expect_equal "index.html has no inline event handlers" "0" "$(curl -sS "$URL/" | grep -Eoc ' on[a-z]+="' || true)"
expect_equal "index.html has no inline style attributes or <style> blocks" "0" "$(curl -sS "$URL/" | grep -Eoc '(<style|style=")' || true)"

echo "nothing secret in the image"
expect_equal "no .env file anywhere in the image" "0" "$(docker run --rm --entrypoint sh "$IMAGE" -c 'find / -xdev \( -name ".env" -o -name ".env.*" -o -name "*.env" \) 2>/dev/null | wc -l')"
expect_equal "no private key file in the image (the system's public CA certificates are not keys)" "0" "$(docker run --rm --entrypoint sh "$IMAGE" -c 'grep -rIl -e "BEGIN [A-Z ]*PRIVATE KEY" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | wc -l')"
expect_equal "the site key is in the built JS (it is public) " "1" "$(docker run --rm --entrypoint sh "$IMAGE" -c 'grep -rl "1x00000000000000000000AA" /usr/share/nginx/html | wc -l' | awk '{print ($1>0)?1:0}')"

finish
