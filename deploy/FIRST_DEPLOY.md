# First deploy: TriageIQ on the Contabo server

Every step says **where** to run it (LAPTOP or SERVER), the **command**, and **what success looks like**. Do them in order and stop at the first step that does not look right: the "If something goes wrong" section at the end is for that.

Secrets: you type them into files with `nano` on the server. **Never paste a key into a chat, a ticket or a shell command line** (the shell history keeps command lines). Nothing in these steps asks you to.

Names used below: server `contabo` (your ssh alias), user `tony`, site `https://triageiq.bamstoneopus.com`, server IP `185.174.254.219`.

> One difference from the order you might expect: the **API client keys are made before the first deploy** (step 8), not after it. The gateway refuses to start with an empty or placeholder client list, and `deploy.sh` refuses a placeholder too. The key script only needs the gateway *image*, so it runs fine before anything is started.

---

## 0. Before you start (LAPTOP)

Have these ready (none of them goes in this file):

- a **Cloudflare Turnstile widget** for the hostname `triageiq.bamstoneopus.com`: its **site key** (public) and **secret key**;
- **new** Anthropic and Voyage API keys for the server (not the ones on your laptop);
- the repository variable `VITE_TURNSTILE_SITE_KEY` set to that **site key** (GitHub: Settings > Secrets and variables > Actions > Variables), set **before** the merge that published the images (the web image has the key baked in), and the three packages public.

Check three things:

```bash
cd ~/triageiq
git fetch origin
TAG="sha-$(git rev-parse origin/main | cut -c1-7)"; echo "$TAG"
docker manifest inspect ghcr.io/obiomaikpe/triageiq-web:$TAG >/dev/null && echo "web image exists"
docker manifest inspect ghcr.io/obiomaikpe/triageiq-gateway:$TAG >/dev/null && echo "gateway image exists"
docker manifest inspect ghcr.io/obiomaikpe/triageiq-app:$TAG >/dev/null && echo "app image exists"
dig +short triageiq.bamstoneopus.com
ssh contabo 'echo connected as $(whoami)'
```

Success: a tag like `sha-17156a6`, three "image exists" lines, `185.174.254.219`, and `connected as tony`. Write the tag down: you use it in steps 8 and 9. (If an `image exists` line fails, the GitHub CI run for that commit did not publish: look at the Actions tab; the `publish-images` job.)

Also confirm the **web image has your real site key**, because it cannot be changed afterwards without a new image: in the CI run for that commit, the `publish-images` job's "The Turnstile site key variable is set" step passed.

## 1. Copy the deploy folder to the server (LAPTOP)

```bash
cd ~/triageiq
rsync -az --delete --exclude 'env/*.env' --exclude '.env' --exclude 'env.local-test/' --exclude '.deploy-state' deploy/ contabo:~/deploy-staging/
```

Success: it finishes silently. `ssh contabo 'ls ~/deploy-staging'` lists `deploy.sh`, `docker-compose.prod.yml`, `edge`, `server`, ... and `ssh contabo 'ls ~/deploy-staging/env'` shows only `*.example` files (no real secret is copied; you have none yet).

It goes to a staging folder because `/opt/triageiq` does not exist until step 2.

## 2. Prepare the server: Docker, swap, updates, the edge network (SERVER)

```bash
ssh contabo
sudo ~/deploy-staging/server/setup.sh
```

It asks for your sudo password once. It takes 1 to 3 minutes. It is safe to run again.

Success: seven lines `[1/7]` ... `[7/7]` and a **report** at the end showing: `Docker version 2x...`, `Docker Compose version v2...`, `swap: /swapfile 2G`, `swappiness: 10`, `docker logs: json-file {'max-size': '10m', 'max-file': '3'}`, `docker group: ... tony`, `networks: ... edge ...`, and under "ports published by running containers": `none`. The ufw lines show `OpenSSH`, `80` and `443` allowed.

**About Docker and UFW:** Docker opens the ports of a container with its own firewall rules, evaluated *before* UFW's, so `ufw deny` does **not** hide a published port. Our design cannot trip over this: the TriageIQ stack publishes no ports, and the only stack that publishes any (the edge Caddy, step 5) publishes exactly 80 and 443, which UFW allows anyway. You will check that at the end (step 12).

## 3. Log out and back in (SERVER)

The docker group only applies to new sessions.

```bash
exit
ssh contabo
docker ps
docker network ls | grep edge
free -h | grep -i swap
```

Success: `docker ps` prints an empty table (no "permission denied"), `edge` is in the network list, and swap shows `2.0Gi` total.

## 4. Put the files where they live (SERVER)

```bash
cp -a ~/deploy-staging/edge/. /opt/edge/
mkdir -p /opt/triageiq/deploy
cp -a ~/deploy-staging/. /opt/triageiq/deploy/
rm -r /opt/triageiq/deploy/edge
rm -r ~/deploy-staging
ls /opt/edge /opt/triageiq/deploy
```

Success: `/opt/edge` has `Caddyfile`, `docker-compose.yml`, `sites`, ...; `/opt/triageiq/deploy` has `deploy.sh`, `docker-compose.prod.yml`, `env`, ... and **no** `edge` folder.

## 5. Start the edge Caddy (SERVER)

```bash
cd /opt/edge
cp .env.example .env
nano .env                      # set ACME_EMAIL to a mailbox you read; save with Ctrl+O, Enter, exit with Ctrl+X
docker compose up -d
docker compose ps
docker compose logs caddy 2>&1 | grep -iE "certificate obtained|obtain|error" | tail
```

Success: `docker compose ps` shows `caddy ... (healthy)` with ports `0.0.0.0:80->80/tcp`, `0.0.0.0:443->443/tcp`, `443/udp`. Within about 30 seconds the log shows `certificate obtained successfully` for `triageiq.bamstoneopus.com`. From your laptop:

```bash
curl -sI https://triageiq.bamstoneopus.com | head -3
```

Success: a valid HTTPS answer: `HTTP/2 502` (nothing to forward to yet: that is correct at this point) and **no** certificate warning. (If the log shows an ACME error instead, go to "Certificate not issued" below before continuing.)

## 6. Generate the secrets (SERVER)

```bash
cd /opt/triageiq/deploy
./make-secrets.sh
```

Success: lines like `POSTGRES_PASSWORD in db.env: new random value` (no value is printed), then a "Still to fill in BY HAND" list: `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` in app.env and `TURNSTILE_SECRET_KEY`, `GATEWAY_CLIENTS` in gateway.env.

## 7. Add YOUR secrets and settings with nano (SERVER)

```bash
nano env/app.env        # ANTHROPIC_API_KEY=...   VOYAGE_API_KEY=...        (type or paste on the server only)
nano env/gateway.env    # TURNSTILE_SECRET_KEY=...   and check the four lines below
```

In `env/gateway.env` these must read exactly:

```
ALLOWED_ORIGINS=https://triageiq.bamstoneopus.com
TURNSTILE_EXPECTED_HOSTNAMES=triageiq.bamstoneopus.com
PUBLIC_DAILY_CAP=30
MAIL_ENABLED=false
```

(They are the defaults in the example; check them anyway. `PUBLIC_DAILY_CAP=30` caps the public form at 30 accepted tickets per day, until the real cost per ticket is known. Email stays off in this step.) Leave `GATEWAY_CLIENTS` for step 8.

Check, printing **names only** (never values):

```bash
grep -nE 'REPLACE_ME|replace-with|0{64}' env/*.env | cut -d= -f1
```

Success: exactly one line, about `GATEWAY_CLIENTS` in `env/gateway.env`. Anything else listed is still a placeholder: fix it.

## 8. Create NEW API client keys (SERVER)

The old keys were exposed and must never be used again. This uses the gateway *image*; nothing is started. Use the tag from step 0 (here `sha-17156a6`):

```bash
cd /opt/triageiq/deploy
TAG=sha-17156a6                           # <- your tag from step 0 (a plain shell variable: do not `export` it)
docker pull ghcr.io/obiomaikpe/triageiq-gateway:$TAG
docker run --rm ghcr.io/obiomaikpe/triageiq-gateway:$TAG node scripts/make-client-key.ts web-submitter submitter
docker run --rm ghcr.io/obiomaikpe/triageiq-gateway:$TAG node scripts/make-client-key.ts ops-reviewer reviewer
```

Each prints the **API key once** (`tiq_...`) and a **registry entry** (a line starting `{"name":...`). **Copy each key into your password manager now**: it cannot be recovered, and the server keeps only its hash. Then put the two entries into one JSON array:

```bash
nano env/gateway.env
# GATEWAY_CLIENTS='[ <entry 1> , <entry 2> ]'      one line, in single quotes, the two {...} separated by a comma
```

Success: `grep -nE 'REPLACE_ME|replace-with|0{64}' env/*.env | cut -d= -f1` now prints **nothing**. Then `clear` the terminal so the keys are not left on screen (`history -c` is not needed: the keys were output, not typed).

## 9. Deploy (SERVER)

```bash
cd /opt/triageiq/deploy
./deploy.sh $TAG
```

It checks the env files, pulls the three images, runs the gateway migrations, starts everything and waits for readiness. Takes 1 to 3 minutes.

Success: seven numbered steps ending with a table of `app`, `triageiq-gateway`, `triageiq-web` (healthy), then

```
Running TAG: sha-17156a6
Previous TAG: none   (./deploy.sh --rollback returns to it)
```

If it stops: the message names the step. `deploy.sh` never prints a secret. See "If something goes wrong".

Two quick checks:

```bash
docker compose -f docker-compose.prod.yml ps
curl -s https://triageiq.bamstoneopus.com/api/ready
```

Success: all services `healthy`; and `/api/ready` answers `{"status":"ready"...}` (HTTP 200).

## 10. Create your reviewer account (SERVER)

```bash
docker compose -f docker-compose.prod.yml exec -it triageiq-gateway node dist/scripts/reviewers.js create --email you@example.com --name "Your Name"
```

It asks for a password twice (nothing is shown as you type). Use a long one. Success: `Created reviewer you@example.com (Your Name).`

## 11. Load the knowledge base (SERVER)

This makes 5 Voyage embedding calls (a few cents at most). With the free-tier limit of 3 requests per minute it takes about two minutes.

```bash
docker compose -f docker-compose.prod.yml exec app python -m app.kb.ingest
docker compose -f docker-compose.prod.yml exec db sh -c 'psql -U "$POSTGRES_USER" -d triageiq -tAc "select count(*) from kb_documents"'
```

Success: `Applying database migrations...`, five `saved: ...` lines, `Done.`; then the count prints `5`. (It runs as the app's limited database role and writes through the same code the app uses. Running it again just updates the same five.)

## 12. Install the nightly backup and run one (SERVER)

```bash
cd /opt/triageiq/deploy
sudo cp systemd/triageiq-backup.service systemd/triageiq-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now triageiq-backup.timer
systemctl list-timers triageiq-backup.timer
sudo systemctl start triageiq-backup.service
journalctl -u triageiq-backup.service -n 12 --no-pager
sudo ls -l /var/backups/triageiq/$(date +%F)
```

Success: the timer's NEXT column is tomorrow 03:30; the journal shows `backup: triageiq ok (... bytes)`, `backup: gateway ok (... bytes)`, `backup: done`; the folder holds `gateway.dump` and `triageiq.dump`, both `-rw-------` (600) owned by root. (The service/timer files assume the folder is `/opt/triageiq/deploy`, which it is.)

## 13. Check the whole thing (LAPTOP, browser)

1. **HTTPS:** open `https://triageiq.bamstoneopus.com`. Success: the padlock, no warning, the "Contact support" form, and the Turnstile widget loads (it may show a brief checkbox or just a tick).
2. **API:** `curl -s https://triageiq.bamstoneopus.com/api/ready` returns ready JSON.
3. **Submit a form ticket** (this makes real model calls: a cent or two). Fill the form with something like *"I forgot my password and the reset email expired"*, send it. Success: a confirmation with a reference like `TKT-7K3M9Q`.
4. **Log in** at `https://triageiq.bamstoneopus.com/login` with the reviewer account. Success: you land on the queue.
5. **See the ticket:** open the *Pending* tab (or *Auto-handled* if the AI was confident): the ticket is there. Open it: Success: classification, a drafted reply, and a line `AI cost (estimate): $0.0xxx · N tokens`. (Approve/Send does nothing by email: mail is off in this step.)
6. **A backup after real data** (SERVER): `sudo systemctl start triageiq-backup.service && journalctl -u triageiq-backup.service -n 5 --no-pager`. Success: `done`.
7. **Cost:** `docker compose -f docker-compose.prod.yml exec app python -m app.tools.cost_report --last 5` prints one ticket with its estimated cost. Use it to decide when to raise `PUBLIC_DAILY_CAP`.
8. **Memory and ports** (SERVER): `docker stats --no-stream` (every container well under its limit) and
   `docker ps --format '{{.Names}}: {{.Ports}}' | grep -E '0\.0\.0\.0|\[::\]'`. Success: only the edge Caddy line, with 80 and 443 (tcp and udp). Nothing else is published.
9. **Pull the backups to your laptop** (LAPTOP): `rsync -az --rsync-path="sudo rsync" contabo:/var/backups/triageiq/ ~/triageiq-backups/` then `ls -l ~/triageiq-backups`. Success: the dated folder with both dumps.

When all nine pass, the first deploy is finished. From now on: `ssh contabo`, `cd /opt/triageiq/deploy`, `./backup.sh`, `./deploy.sh sha-<new>`; `./deploy.sh --rollback` goes back. New files from the laptop: re-run the rsync of step 1 but straight to `contabo:/opt/triageiq/deploy/` (and `deploy/edge/` to `contabo:/opt/edge/`).

---

## If something goes wrong

### The certificate is not issued (step 5)

`cd /opt/edge && docker compose logs caddy 2>&1 | grep -iE "error|acme|challenge" | tail -20`

- **DNS:** `dig +short triageiq.bamstoneopus.com` must print `185.174.254.219` (from your laptop **and** `dig +short triageiq.bamstoneopus.com @1.1.1.1`). A different or empty answer: fix DNS and wait; Caddy retries by itself.
- **Port 80 or 443 not reachable from the internet:** `sudo ufw status` must allow 80 and 443. From the laptop: `curl -sv --max-time 8 http://triageiq.bamstoneopus.com/ 2>&1 | head` should connect (a redirect or empty answer is fine; a timeout is not). Check the Contabo control panel's firewall too, if you enabled one there.
- **Something else on port 80/443 on the server:** `sudo ss -ltnp | grep -E ':80 |:443 '` should show only docker-proxy for the Caddy container. (Apache or nginx installed by the image? `sudo systemctl disable --now nginx apache2`.)
- **Let's Encrypt rate limits** (several failed tries in an hour): wait an hour, or test against the staging CA by temporarily adding `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` inside the `{ ... }` block at the top of `/opt/edge/Caddyfile` (browsers will warn about a staging certificate), then remove it and `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
- **A typo in a site file:** `docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile` names it.

### 502 from Caddy

502 means Caddy cannot reach the app (it is not a certificate problem).

```bash
cd /opt/triageiq/deploy
docker compose -f docker-compose.prod.yml ps                       # anything unhealthy or restarting?
docker compose -f docker-compose.prod.yml logs --tail 30 triageiq-gateway triageiq-web
docker exec edge-caddy-1 wget -qO- http://triageiq-gateway:3000/health      # {"status":"ok"} if Caddy can reach it
docker network inspect edge --format '{{range .Containers}}{{.Name}} {{end}}'   # both triageiq containers must be listed
```

- Nothing running: `./deploy.sh <tag>` again (it prints the failing step).
- The `wget` fails but the container is healthy: the container is not on `edge` (the stack was started with a different `EDGE_NETWORK`, or `edge` was recreated): `docker compose -f docker-compose.prod.yml up -d --force-recreate triageiq-gateway triageiq-web`.
- Only `/api/...` gives 502 but the page loads: the gateway is down: see the next heading.

### The gateway refuses to start (production guard)

`docker compose -f docker-compose.prod.yml logs --tail 20 triageiq-gateway` (or `app`). The message names the **setting**, never its value:

| Message contains | Fix in `env/...` |
|---|---|
| `COOKIE_SECURE must be true in production` | `gateway.env`: `COOKIE_SECURE=true` |
| `ALLOWED_ORIGINS must contain only https:// origins` | `ALLOWED_ORIGINS=https://triageiq.bamstoneopus.com` |
| `TURNSTILE_SECRET_KEY is one of Cloudflare's documented TEST secrets` | your real secret from the Turnstile dashboard |
| `... still has its .example placeholder value` (or `GATEWAY_CLIENTS still has the .example placeholder client`) | that setting is still a placeholder: fill it (step 7 / 8) |
| `SMTP_HOST is mailpit while MAIL_ENABLED is true` | `MAIL_ENABLED=false` (until M6c-2) |
| python: `Refusing to start in production: ... ANTHROPIC_API_KEY is not set` (etc.) | `app.env` |
| `Invalid gateway configuration: X is missing / is invalid` | that setting in `gateway.env` |

Then `./deploy.sh <same tag>` (it re-checks the files and restarts). `./deploy.sh --rollback` goes back to the previous version if the problem came with the update.

### Out of memory

Signs: a container restarting; slowness; `dmesg` lines about "Out of memory".

```bash
docker stats --no-stream
docker inspect -f '{{.Name}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' $(docker ps -aq)
free -h
sudo dmesg | grep -iE "out of memory|oom-kill" | tail
```

- A container shows `oom=true`: it hit **its own limit** (Docker killed it and restarted it; the host is fine). If it is `app` or `triageiq-gateway` under real load, raise that one `mem_limit` in `docker-compose.prod.yml` (app 512m -> 768m is the first candidate) and `./deploy.sh <tag>`; lower `WORKER_CONCURRENCY` in the compose file if it keeps happening.
- `free -h` shows swap nearly full and `available` low: the host is short. Stop what you do not need, or add the other apps later with care (the plan: all TriageIQ limits + the edge add up to 1.73 GB; Ubuntu and Docker need about 0.5 GB).
- Swap missing (`free -h` shows 0 swap after a reboot): `sudo ./server/setup.sh` again; it restores the fstab line.

### Other

- **The form says "Verification couldn't load":** the page's Turnstile site key is wrong or missing (the key is baked into the web image: it needs the repository variable and a new image), or the widget's allowed hostname in the Cloudflare dashboard is not `triageiq.bamstoneopus.com`. Look at the browser console for a blocked request.
- **`deploy.sh` says "pull failed":** the tag does not exist or the packages are not public: `docker manifest inspect ghcr.io/obiomaikpe/triageiq-app:<tag>`.
- **After a reboot nothing runs:** the containers have `restart: unless-stopped`, so Docker brings them back; give it a minute, then `docker ps`. If the edge or the stack is missing: `cd /opt/edge && docker compose up -d`; `cd /opt/triageiq/deploy && ./deploy.sh $(./deploy.sh --status | head -1 | awk '{print $2}')`.
- **Keeping Docker itself up to date** (Ubuntu's automatic updates do not cover Docker's own repository): every month or two, `sudo apt-get update && sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`. Containers restart by themselves afterwards; do it at a quiet time and run `./backup.sh` first.
- **Reboot after kernel updates:** if `/var/run/reboot-required` exists, `sudo reboot` at a quiet time (everything comes back by itself).
