#!/usr/bin/env bash
# deploy/server/setup.sh in a THROWAWAY ubuntu:24.04 container (no systemd, no Docker daemon, so swap and the network step are
# skipped there): Docker's apt repository really resolves for noble, the packages install, the files it writes are right, and a
# second run changes nothing. LOCAL ONLY (it downloads about 300 MB); CI does not run it.   deploy/tests/test-setup.sh
source "$(dirname "$0")/lib.sh"
NAME="tiq-setup-test-$RUN_ID"; CLEANUP_CONTAINERS+=("$NAME")
docker run -d --name "$NAME" -v "$REPO/deploy/server/setup.sh:/setup.sh:ro" ubuntu:24.04 sleep 3600 >/dev/null
ex() { docker exec "$NAME" bash -c "$1"; }
ex 'useradd -m -s /bin/bash tony && apt-get update -qq && apt-get install -y -qq sudo >/dev/null'

echo "refusals"
expect_failure "refuses without root" docker exec -u tony "$NAME" bash /setup.sh
expect_failure "refuses when it cannot tell the user (root, no --user)" docker exec "$NAME" bash /setup.sh
expect_failure "refuses a user that does not exist" docker exec "$NAME" bash /setup.sh --user nobody-here

echo "first run (as root via sudo from tony)"
docker exec -e SETUP_SKIP=swap,network -e SUDO_USER=tony "$NAME" bash /setup.sh > "${TMPDIR:-/tmp}/tiq-setup-1.$$" 2>&1 && pass "setup.sh succeeds" || { tail -20 "${TMPDIR:-/tmp}/tiq-setup-1.$$" >&2; fail "setup.sh succeeds"; }
expect_success "docker engine is installed" ex 'docker --version | grep -q "Docker version"'
expect_success "the compose plugin is installed" ex 'docker compose version | grep -q "Docker Compose version"'
expect_success "the buildx plugin is installed" ex 'docker buildx version >/dev/null'
expect_success "docker came from download.docker.com, not Ubuntu" ex 'apt-cache policy docker-ce | grep -q "download.docker.com"'
expect_equal "the apt source is the official deb822 file" "Types: deb|URIs: https://download.docker.com/linux/ubuntu|Suites: noble|Components: stable|Architectures: amd64|Signed-By: /etc/apt/keyrings/docker.asc" "$(ex 'paste -sd"|" /etc/apt/sources.list.d/docker.sources')"
expect_success "the key file is world-readable" ex 'test "$(stat -c %a /etc/apt/keyrings/docker.asc)" = 644'
expect_equal "daemon.json rotates logs" "json-file 10m 3" "$(ex "python3 -c \"import json;c=json.load(open('/etc/docker/daemon.json'));print(c['log-driver'], c['log-opts']['max-size'], c['log-opts']['max-file'])\"")"
expect_success "tony is in the docker group" ex 'id -nG tony | tr " " "\n" | grep -qx docker'
expect_equal "swappiness file" "vm.swappiness=10" "$(ex 'cat /etc/sysctl.d/99-triageiq.conf')"
expect_equal "unattended upgrades are switched on" 'APT::Periodic::Update-Package-Lists "1";|APT::Periodic::Unattended-Upgrade "1";' "$(ex 'paste -sd"|" /etc/apt/apt.conf.d/20auto-upgrades')"
expect_equal "/opt/edge and /opt/triageiq belong to tony" "tony:tony tony:tony" "$(ex 'echo "$(stat -c %U:%G /opt/edge) $(stat -c %U:%G /opt/triageiq)"')"
expect_equal "the script never changes ssh or ufw (only reads ufw status)" "0" "$(grep -v '^[[:space:]]*#' "$REPO/deploy/server/setup.sh" | grep -cE 'sshd_config|ufw (allow|deny|enable|disable|reset|delete|limit)' || true)"

echo "second run changes nothing"
SUM1="$(ex 'cat /etc/docker/daemon.json /etc/apt/sources.list.d/docker.sources /etc/apt/apt.conf.d/20auto-upgrades /etc/sysctl.d/99-triageiq.conf | md5sum; ls /etc/docker | md5sum; stat -c %Y /etc/docker/daemon.json')"
docker exec -e SETUP_SKIP=swap,network -e SUDO_USER=tony "$NAME" bash /setup.sh > "${TMPDIR:-/tmp}/tiq-setup-2.$$" 2>&1 && pass "second run succeeds" || fail "second run succeeds"
SUM2="$(ex 'cat /etc/docker/daemon.json /etc/apt/sources.list.d/docker.sources /etc/apt/apt.conf.d/20auto-upgrades /etc/sysctl.d/99-triageiq.conf | md5sum; ls /etc/docker | md5sum; stat -c %Y /etc/docker/daemon.json')"
expect_equal "every file is byte-identical, daemon.json was not rewritten, no .bak made" "$SUM1" "$SUM2"
expect_equal "the second run reports 'already done' for each file step" "5" "$(grep -c 'already done' "${TMPDIR:-/tmp}/tiq-setup-2.$$")"

echo "an existing daemon.json is merged, not replaced"
ex 'echo "{\"dns\": [\"1.1.1.1\"], \"log-opts\": {\"max-size\": \"50m\"}}" > /etc/docker/daemon.json'
docker exec -e SETUP_SKIP=swap,network -e SUDO_USER=tony "$NAME" bash /setup.sh >/dev/null 2>&1
expect_equal "dns kept, log settings applied, a backup kept" "1.1.1.1 json-file 10m 3 1" "$(ex "python3 -c \"import json;c=json.load(open('/etc/docker/daemon.json'));print(c['dns'][0], c['log-driver'], c['log-opts']['max-size'], c['log-opts']['max-file'])\"") $(ex 'ls /etc/docker/daemon.json.bak-* | wc -l | tr -d " "')"
echo "a daemon.json that is not JSON stops the script before it changes anything"
ex 'echo "{ not json" > /etc/docker/daemon.json'
expect_failure "invalid daemon.json is refused" docker exec -e SETUP_SKIP=swap,network -e SUDO_USER=tony "$NAME" bash /setup.sh
expect_equal "and the file was left as it was" "{ not json" "$(ex 'cat /etc/docker/daemon.json')"
command rm -f "${TMPDIR:-/tmp}/tiq-setup-1.$$" "${TMPDIR:-/tmp}/tiq-setup-2.$$"
finish
