#!/usr/bin/env bash
# One-time server preparation for TriageIQ and every later app: Ubuntu 24.04 (x86_64), run ONCE by you with sudo. Safe to re-run:
# every step checks first and says "already done" when it is.
#
#   sudo ./setup.sh                    (as the user that will run the stacks, e.g. tony: it reads $SUDO_USER)
#   sudo ./setup.sh --user tony        (when you are not using sudo from that user)
#
# What it does:
#   1. Docker Engine + the compose plugin, from DOCKER'S OWN apt repository (docs.docker.com/engine/install/ubuntu, deb822 source,
#      key in /etc/apt/keyrings/docker.asc). Not Ubuntu's docker.io package, not the get.docker.com script.
#   2. Docker log rotation (daemon.json: json-file, 10 MB x 3 files) so no container can fill the disk with logs.
#   3. Adds the user to the docker group (a docker-group member is effectively root: only people you trust).
#   4. A 2 GB swapfile (kept in /etc/fstab) and vm.swappiness=10: swap is a safety net against out-of-memory kills, not extra RAM.
#   5. Automatic security updates (unattended-upgrades, Ubuntu security pocket only, NO automatic reboot).
#   6. /opt/edge and /opt/triageiq, owned by the user.
#   7. The external Docker network "edge" that the shared Caddy and every app join.
# It does NOT touch SSH, UFW or any existing container. It prints a report at the end.
#
# THE DOCKER-vs-UFW GOTCHA. Docker opens a published port with its own iptables rules, which are evaluated BEFORE UFW's. So
# `ufw deny 8080` does NOT hide a container started with `-p 8080:8080`: it is reachable from the internet anyway, and `ufw status`
# will not show it. Our design avoids the whole problem: the app stacks publish NO ports (deploy/docker-compose.prod.yml has none,
# and a test fails if one appears), and the only compose file that publishes anything is deploy/edge/docker-compose.yml, which
# publishes exactly 80, 443/tcp and 443/udp: the three UFW allows anyway. The report at the end lists every published port.
#
# Test hooks (used by deploy/tests/test-setup.sh inside a throwaway container; leave unset on a real server):
#   SETUP_SKIP="swap,network"   skip those steps
set -euo pipefail

TARGET_USER="${SUDO_USER:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --user) TARGET_USER="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Run this with sudo:  sudo $0" >&2; exit 1; }
{ [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != root ] && id "$TARGET_USER" >/dev/null 2>&1; } || { echo "Cannot tell which user the stacks are for. Run it with sudo from that user, or: sudo $0 --user tony" >&2; exit 1; }

SKIP=",${SETUP_SKIP:-},"
skip() { case "$SKIP" in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
say()  { printf '\n[%s] %s\n' "$1" "$2"; }
done_already() { echo "    already done: $1"; }
export DEBIAN_FRONTEND=noninteractive
have_systemd() { [ -d /run/systemd/system ]; }
# write_if_changed <path> <mode> <content>: installs the file only when it differs. Returns 0 when it wrote, 1 when it was already right.
write_if_changed() {
  local tmp; tmp="$(mktemp)"; printf '%s\n' "$3" > "$tmp"
  if cmp -s "$tmp" "$1"; then command rm -f "$tmp"; return 1; fi
  install -m "$2" "$tmp" "$1"; command rm -f "$tmp"; return 0
}

# --- 0. is this the machine we think it is? ---------------------------------------------------------------------------------------
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  echo "This script is written for Ubuntu 24.04 (this is ${PRETTY_NAME:-unknown}). Refusing: the Docker repository lines depend on it." >&2
  exit 1
fi
ARCH="$(dpkg --print-architecture)"
echo "Ubuntu $VERSION_ID ($VERSION_CODENAME), $ARCH, user $TARGET_USER"

# --- 1. Docker Engine from Docker's apt repository ----------------------------------------------------------------------------------
say 1/7 "Docker Engine and the compose plugin (Docker's official apt repository)"
apt-get update -qq
apt-get install -y -qq ca-certificates curl python3 >/dev/null

# Unofficial packages that conflict with Docker's (the list from docs.docker.com). Removing is a no-op on a fresh server.
CONFLICTS=(docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc)
PRESENT=()
for p in "${CONFLICTS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 && PRESENT+=("$p"); done
if [ "${#PRESENT[@]}" -gt 0 ]; then
  echo "    removing conflicting packages: ${PRESENT[*]}"
  apt-get remove -y -qq "${PRESENT[@]}"
fi

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

WANT_SOURCE="Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $ARCH
Signed-By: /etc/apt/keyrings/docker.asc
"
if write_if_changed /etc/apt/sources.list.d/docker.sources 0644 "${WANT_SOURCE%$'\n'}"; then
  echo "    wrote /etc/apt/sources.list.d/docker.sources"
else
  done_already "/etc/apt/sources.list.d/docker.sources"
fi
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
echo "    $(dpkg-query -W -f='docker-ce ${Version}' docker-ce)"

# --- 2. Docker log rotation ---------------------------------------------------------------------------------------------------------
say 2/7 "Docker log rotation (json-file, max-size 10m, max-file 3)"
DAEMON=/etc/docker/daemon.json
mkdir -p /etc/docker
CHANGED="$(python3 - "$DAEMON" <<'PY'
import json, os, shutil, sys, time
path = sys.argv[1]
cfg = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    with open(path) as f:
        cfg = json.load(f)          # a daemon.json that is not valid JSON stops the script here, before anything is changed
want = {"log-driver": "json-file"}
opts = dict(cfg.get("log-opts", {}))
opts.update({"max-size": "10m", "max-file": "3"})
want["log-opts"] = opts
new = {**cfg, **want}
if new == cfg:
    print("no")
else:
    if os.path.exists(path):
        shutil.copy2(path, f"{path}.bak-{int(time.time())}")
    with open(path, "w") as f:
        json.dump(new, f, indent=2); f.write("\n")
    print("yes")
PY
)"
if [ "$CHANGED" = yes ]; then
  echo "    wrote $DAEMON (any earlier file was kept as daemon.json.bak-<time>)"
  NEED_RESTART=1
else
  done_already "$DAEMON"; NEED_RESTART=0
fi
if have_systemd; then
  systemctl enable docker >/dev/null 2>&1 || true
  if [ "$NEED_RESTART" = 1 ] || ! systemctl is-active --quiet docker; then
    systemctl restart docker
    echo "    docker restarted (log settings apply to containers created from now on)"
  fi
fi

# --- 3. docker group ---------------------------------------------------------------------------------------------------------------
say 3/7 "$TARGET_USER in the docker group"
if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx docker; then
  done_already "$TARGET_USER is in the docker group"
else
  usermod -aG docker "$TARGET_USER"
  echo "    added. $TARGET_USER must LOG OUT AND IN AGAIN (a new ssh session) before it takes effect."
fi

# --- 4. swap + swappiness ---------------------------------------------------------------------------------------------------------------
say 4/7 "2 GB swapfile and vm.swappiness=10"
if skip swap; then
  echo "    swapfile skipped (SETUP_SKIP)"
elif swapon --show=NAME --noheadings | grep -qx /swapfile && grep -qE '^/swapfile[[:space:]]+none[[:space:]]+swap' /etc/fstab; then
  done_already "/swapfile is active and in /etc/fstab"
else
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    echo "    created /swapfile (2 GB)"
  fi
  chmod 600 /swapfile
  swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile
  grep -qE '^/swapfile[[:space:]]+none[[:space:]]+swap' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "    /swapfile is active and listed in /etc/fstab (survives a reboot)"
fi
if write_if_changed /etc/sysctl.d/99-triageiq.conf 0644 "vm.swappiness=10"; then
  echo "    wrote /etc/sysctl.d/99-triageiq.conf"
else
  done_already "/etc/sysctl.d/99-triageiq.conf"
fi
sysctl -q -w vm.swappiness=10 || echo "    (could not set it live here; it applies at the next boot)"

# --- 5. unattended security upgrades ---------------------------------------------------------------------------------------------------------
say 5/7 "automatic security updates (unattended-upgrades)"
apt-get install -y -qq unattended-upgrades >/dev/null
AUTO='APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
'
if write_if_changed /etc/apt/apt.conf.d/20auto-upgrades 0644 "${AUTO%$'\n'}"; then
  echo "    wrote /etc/apt/apt.conf.d/20auto-upgrades"
else
  done_already "/etc/apt/apt.conf.d/20auto-upgrades"
fi
have_systemd && systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
echo "    Ubuntu's own security updates install by themselves. It does NOT reboot (a new kernel needs a manual reboot: 'sudo reboot' when"
echo "    /var/run/reboot-required exists) and does NOT update Docker (that comes from Docker's repository: see FIRST_DEPLOY.md, 'Keeping Docker up to date')."

# --- 6. directories --------------------------------------------------------------------------------------------------------------------------------
say 6/7 "/opt/edge and /opt/triageiq owned by $TARGET_USER"
for d in /opt/edge /opt/triageiq; do
  mkdir -p "$d"
  chown "$TARGET_USER":"$TARGET_USER" "$d"
  chmod 755 "$d"
  echo "    $d  $(stat -c '%U:%G %a' "$d")"
done

# --- 7. the edge network -------------------------------------------------------------------------------------------------------------------------------
say 7/7 'the external Docker network "edge"'
if skip network; then
  echo "    skipped (SETUP_SKIP)"
elif docker network inspect edge >/dev/null 2>&1; then
  done_already 'network "edge"'
else
  docker network create edge >/dev/null
  echo '    created network "edge"'
fi

# --- report ------------------------------------------------------------------------------------------------------------------------------------------------
echo
echo "================ report ================"
docker --version
docker compose version
skip swap || { echo "swap:        $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"; echo "swappiness:  $(cat /proc/sys/vm/swappiness)"; }
echo "docker logs: $(python3 -c "import json;c=json.load(open('/etc/docker/daemon.json'));print(c['log-driver'], c['log-opts'])")"
echo "docker group: $(getent group docker | cut -d: -f4)"
if docker info >/dev/null 2>&1; then
  skip network || echo "networks:    $(docker network ls --format '{{.Name}}' | tr '\n' ' ')"
  PUBLISHED="$(docker ps --format '{{.Names}}: {{.Ports}}' | grep -E '0\.0\.0\.0|\[::\]' || true)"
  echo "ports published by running containers on ALL addresses (these bypass UFW):"
  echo "${PUBLISHED:-    none}"
fi
if command -v ufw >/dev/null 2>&1; then echo "ufw:"; ufw status | sed 's/^/    /'; fi
echo "========================================"
echo "Next: log out and in again (docker group), then continue with FIRST_DEPLOY.md step 4."
