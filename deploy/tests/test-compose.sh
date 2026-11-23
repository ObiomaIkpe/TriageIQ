#!/usr/bin/env bash
# Static checks of deploy/docker-compose.prod.yml (and the local-test override) on the RESOLVED configuration: nothing is started.
# Needs docker compose and python3.
source "$(dirname "$0")/lib.sh"

TMP="$(mktemp -d)"; CLEANUP_DIRS+=("$TMP")
for n in db app gateway; do cp "$REPO/deploy/env/$n.env.example" "$TMP/$n.env"; done
export ENV_DIR="$TMP" TAG=sha-abc1234 GHCR_OWNER=someone
PROD="$REPO/deploy/docker-compose.prod.yml" TEST="$REPO/deploy/docker-compose.local-test.yml"

docker compose -f "$PROD" config --format json > "$TMP/prod.json" 2>"$TMP/err" || { cat "$TMP/err" >&2; fail "the prod compose file does not resolve"; finish; }
docker compose -f "$PROD" -f "$TEST" config --format json > "$TMP/test.json" 2>"$TMP/err2" || { cat "$TMP/err2" >&2; fail "prod + local-test do not resolve"; finish; }
pass "both configurations resolve"
unset TAG
expect_failure "a missing TAG is refused (no accidental :latest)" docker compose -f "$PROD" config -q

python3 - "$TMP/prod.json" "$TMP/test.json" "$TMP" "$PROD" <<'PY' | while IFS= read -r line; do case "$line" in OK*) echo "  ok   - ${line#OK }";; *) echo "  FAIL - ${line#FAIL }" >&2; echo FAILED >> "$TMP/failed";; esac; done
import json, re, sys
prod, test = (json.load(open(p)) for p in sys.argv[1:3])
TMP, PROD_FILE = sys.argv[3], sys.argv[4]
file_keys = {n: {l.split("=", 1)[0] for l in open(f"{TMP}/{n}.env") if re.match(r"^[A-Z_]+=", l)} for n in ("db", "app", "gateway")}
raw = open(PROD_FILE).read()
S, N = prod["services"], prod["networks"]
def check(label, cond): print(("OK " if cond else "FAIL ") + label)

check("the six services exist and no others (no Mailpit)", set(S) == {"db", "redis", "app", "gateway-migrate", "gateway", "web"})
check("NO service publishes a host port", all(not s.get("ports") for s in S.values()))
check("only gateway and web are on the edge network", {n for n, s in S.items() if "edge" in s["networks"]} == {"gateway", "web"})
check("db and redis are on the internal network only", all(list(S[n]["networks"]) == ["backend"] for n in ("db", "redis")))
check("the backend network is internal (no route out)", N["backend"].get("internal") is True)
check("the edge network is external and named edge", N["edge"].get("external") is True and N["edge"]["name"] == "edge")
check("the edge aliases are unique to this app", S["gateway"]["networks"]["edge"]["aliases"] == ["triageiq-gateway"] and S["web"]["networks"]["edge"]["aliases"] == ["triageiq-web"])
check("only app and gateway have outbound (egress) access", {n for n, s in S.items() if "egress" in s["networks"]} == {"app", "gateway"})
for n in ("db", "redis", "app", "gateway", "web"):
    check(f"{n}: restart unless-stopped", S[n].get("restart") == "unless-stopped")
check("gateway-migrate runs once (restart no)", S["gateway-migrate"].get("restart") == "no")
total = 0
for n, s in S.items():
    mem = s.get("mem_limit")
    check(f"{n}: has a memory limit ({mem})", bool(mem))
    if n != "gateway-migrate": total += int(mem)
check(f"the running services' limits add up to under 2 GB ({total // 2**20} MB)", total <= 2 * 2**30)
for n in ("db", "redis", "app", "gateway", "web"):
    check(f"{n}: has a healthcheck", "healthcheck" in S[n])
for n, s in S.items():
    log = s.get("logging", {})
    check(f"{n}: json-file logging, max-size 10m, max-file 3", log.get("driver") == "json-file" and log.get("options") == {"max-size": "10m", "max-file": "3"})
check("gateway keeps stop_grace_period 130s", S["gateway"].get("stop_grace_period") == "2m10s")
for n in ("app", "gateway-migrate", "gateway", "web"):
    check(f"{n}: image is ghcr.io/<owner>/triageiq-*:<TAG>", S[n]["image"].startswith("ghcr.io/someone/triageiq-") and S[n]["image"].endswith(":sha-abc1234"))
check("gateway waits for redis, a healthy app and the finished migration", S["gateway"]["depends_on"]["redis"]["condition"] == "service_healthy" and S["gateway"]["depends_on"]["app"]["condition"] == "service_healthy" and S["gateway"]["depends_on"]["gateway-migrate"]["condition"] == "service_completed_successfully")
check("the gateway runs with NODE_ENV=production", S["gateway"]["environment"]["NODE_ENV"] == "production")
refs = re.findall(r"^\s+- \$\{ENV_DIR:-\./env\}/(\w+)\.env\s*$", raw, re.M)
check(f"secrets come only from env files: the compose file names exactly db.env, app.env, gateway.env (x2) {refs}", sorted(refs) == ["app", "db", "gateway", "gateway"])
owner = {"db": "db", "app": "app", "gateway": "gateway", "gateway-migrate": "gateway"}
inline = [f"{n}.{k}" for n, s in S.items() for k in s.get("environment", {}) if n in owner and k not in file_keys[owner[n]] and any(w in k for w in ("PASSWORD", "SECRET", "API_KEY", "_PASS", "TOKEN"))]
check(f"no secret-looking variable is written in the compose file itself {inline}", not inline)
check("web, gateway and the migration run with a read-only filesystem", all(S[n].get("read_only") is True for n in ("web", "gateway", "gateway-migrate")))
check("no-new-privileges and all capabilities dropped (app, gateway, web)", all("no-new-privileges:true" in S[n].get("security_opt", []) and S[n].get("cap_drop") == ["ALL"] for n in ("app", "gateway", "web")))

T = test["services"]
check("local-test: web and gateway are published on 127.0.0.1 ONLY", all(p["host_ip"] == "127.0.0.1" for n in ("web", "gateway") for p in T[n]["ports"]))
check("local-test: the edge-sim is published on 127.0.0.1 only", all(p["host_ip"] == "127.0.0.1" for p in T["edge-sim"]["ports"]))
check("local-test: nothing else is published (db, redis, app)", all(not T[n].get("ports") for n in ("db", "redis", "app", "gateway-migrate")))
check("local-test: the edge network is created, not external", not test["networks"]["edge"].get("external"))
check("local-test: images are built locally and never pulled", all(T[n].get("pull_policy") == "never" and "build" in T[n] for n in ("app", "gateway", "gateway-migrate", "web")))
PY
[ -f "$TMP/failed" ] && FAILURES=$((FAILURES + $(wc -l < "$TMP/failed")))

# the example env files: every key the compose/guards need is there, and every placeholder is recognisable as one
for f in db app gateway; do
  expect_success "$f.env.example exists" test -f "$REPO/deploy/env/$f.env.example"
done
if grep -rEn '^(POSTGRES_PASSWORD|GATEWAY_DB_PASSWORD|TRIAGEIQ_APP_DB_PASSWORD|ANTHROPIC_API_KEY|VOYAGE_API_KEY|REVIEW_API_KEY|TRIAGE_REVIEW_API_KEY|TURNSTILE_SECRET_KEY)=' "$REPO/deploy/env/"*.example | grep -vq 'REPLACE_ME'; then fail "an example env file holds a value that is not a REPLACE_ME placeholder"; else pass "every secret in the example env files is a REPLACE_ME placeholder"; fi
expect_failure "real env files are git-ignored (deploy/env/app.env)" bash -c "cd '$REPO' && git ls-files --error-unmatch deploy/env/app.env"
expect_equal "git ignores deploy/env/app.env" "deploy/env/app.env" "$(cd "$REPO" && git check-ignore deploy/env/app.env)"
expect_equal "git ignores deploy/.env" "deploy/.env" "$(cd "$REPO" && git check-ignore deploy/.env)"
finish
