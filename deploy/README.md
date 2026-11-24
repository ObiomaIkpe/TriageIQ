# Deploying TriageIQ (runbook)

**Deploying for the first time? Follow [FIRST_DEPLOY.md](FIRST_DEPLOY.md).** This file is the reference behind it.

Everything the server needs is in this folder. The server does **not** need the source code: it pulls three images from GitHub's container registry and starts them with `docker-compose.prod.yml`.

```
deploy/
  docker-compose.prod.yml        the production stack (db, redis, app, gateway-migrate, gateway, web)
  docker-compose.local-test.yml  an override to test that stack on your laptop (see "Test it on your laptop")
  .env.example                   TAG and GHCR_OWNER (copy to .env)
  env/*.env.example              the settings, one file per service (copy to env/*.env, which git ignores)
  make-secrets.sh                fills fresh random passwords and keys, never printing them
  backup.sh  restore.sh          nightly dump of both databases, and restoring one of them
  systemd/                       the nightly timers (backup 03:30, demo reset 04:00)
  demo-reset.sh                  the nightly demo reset (see "Demo mode")
  db/                            the database init scripts (a copy of ../db; deploy/sync-db-sql.sh keeps it in step)
  edge/                          the SHARED Caddy stack (HTTPS for every app on the server) and one site file per app
  server/setup.sh                one-time server preparation (Docker, swap, updates, the edge network); run with sudo
  deploy.sh                      deploy a TAG, or --rollback to the one before
  FIRST_DEPLOY.md                the exact step-by-step for the first deployment
  tests/                         the shell tests CI runs on every pull request
```

## How it is wired

```
internet ──HTTPS──> edge Caddy (separate stack, owns ports 80/443)
                      │  /api/*  (prefix removed) ──> triageiq-gateway:3000  ┐ network "edge"
                      │  everything else         ──> triageiq-web:8080      ┘ (only these two are on it)
                      └─ gateway ──> app (Python) ──> db (Postgres), redis     network "backend": INTERNAL, no route in or out
                                       │                                       network "egress": app + gateway only, for
                                       └──> Anthropic, Voyage (outbound only)  Anthropic, Voyage, Cloudflare, SMTP
```

- **No port is published on the host.** `docker compose -f docker-compose.prod.yml ps` shows none.
- Memory limits (4 GB host): db 512 MB, redis 128 MB (it also refuses writes above 96 MB; BullMQ needs `noeviction`), app 512 MB, gateway 384 MB, web 64 MB, and the edge Caddy 128 MB. That is **1.73 GB** if every service sits at its limit; idle on the laptop they use about 0.3 GB. The one-shot `gateway-migrate` may use 256 MB for a few seconds. About **2.2 GB** is left for Ubuntu, Docker itself (about 150 MB), and one or two more small apps; the 2 GB swapfile `server/setup.sh` makes is the safety net. A service over its limit is killed and restarted by Docker; it cannot take the host down.
- Logs: `json-file`, 10 MB x 3 files per container.
- **Names on `edge`:** the two TriageIQ services that join it are *named* `triageiq-gateway` and `triageiq-web`. Compose makes every service name a DNS name on each network the service joins and cannot be told not to, so a service called `gateway` would be reachable as `gateway` next to every other app's `gateway`. With these names there is nothing bare to collide (the internal `app`, `db`, `redis` are not on `edge`). `deploy/local-test.sh check` proves it with a decoy app that has its own `gateway`/`web`. Other apps must do the same (`edge/sites/README.md`).
- The edge Caddy, and the lines it needs for this app, are in `edge/` (`edge/sites/triageiq.caddy`).

## Before the first install (once)

Everything is in [FIRST_DEPLOY.md](FIRST_DEPLOY.md): what you need in hand (the Turnstile site and secret keys, new Anthropic and Voyage keys, the GitHub variable and public packages) and every command in order.

## First install

See [FIRST_DEPLOY.md](FIRST_DEPLOY.md). In short: `sudo server/setup.sh` once, start `edge/`, `./make-secrets.sh`, edit the env files, `./deploy.sh sha-<commit>`, then the client keys, a reviewer, the knowledge base and the backup timer.

## Update to a new version (a new TAG)

Every merge to `main` publishes images tagged `sha-<first 7 characters of the commit>` and `main`. Use the exact `sha-...` tag.

```bash
cd /opt/triageiq/deploy
./backup.sh                          # a fresh backup first (see "Backups")
./deploy.sh sha-1a2b3c4
```

`deploy.sh` checks the env files, records the running tag as the previous one, pulls, runs the gateway migrations, starts the stack, waits for `/ready` and prints the running tag. The Python service applies its own Alembic migrations when it starts. `./deploy.sh --status` shows the running and the previous tag.

## Roll back

```bash
cd /opt/triageiq/deploy
./deploy.sh --rollback               # back to the tag that ran before the last deploy; running it again returns to the newer one
```

Images roll back; **databases do not** (migrations only go forward). Migrations in this project add nullable columns and tables, which an older image ignores, so rolling back one version is normally safe. If a release changed the schema in a way an older image cannot live with, restore the backup you took before the update (below) after stopping `app` and `triageiq-gateway`.

## Backups

`backup.sh` dumps **both** databases (`triageiq`, `gateway`) with `pg_dump -Fc` through `docker compose exec`, into `/var/backups/triageiq/<YYYY-MM-DD>/` (folders `chmod 700`, dumps `chmod 600`), checks that each dump can be read back, keeps the newest 7 days, and **exits non-zero on any failure** (a failed run deletes nothing). Run it by hand: `./backup.sh`.

**Nightly at 03:30 (server time) with systemd** (install steps, not done by anything here):

```bash
sudo cp systemd/triageiq-backup.service systemd/triageiq-backup.timer /etc/systemd/system/
# if deploy/ is not in /opt/triageiq/deploy, edit WorkingDirectory= and ExecStart= in the .service file first
sudo systemctl daemon-reload
sudo systemctl enable --now triageiq-backup.timer
systemctl list-timers triageiq-backup.timer        # shows the next run
sudo systemctl start triageiq-backup.service        # a test run now
journalctl -u triageiq-backup.service -n 20         # its output; a failed run shows as "failed" in systemctl status
```

**Copy the backups to your laptop** (one line, run on the laptop):

```bash
rsync -az --rsync-path="sudo rsync" contabo:/var/backups/triageiq/ ~/triageiq-backups/
```

(`--rsync-path="sudo rsync"` is needed because the folder is root's. Backups hold customer tickets: keep that folder private.)

**Restore one database** (this REPLACES it; it is exact: tables made after the backup are removed too, in one transaction, so a failed restore changes nothing):

```bash
docker compose -f docker-compose.prod.yml stop triageiq-gateway app        # the script refuses while they run
./restore.sh /var/backups/triageiq/2026-11-23/triageiq.dump        # asks you to type the database name
docker compose -f docker-compose.prod.yml up -d
```

The gateway database restores the same way (`gateway.dump`; only `triageiq-gateway` needs to be stopped). A dump is only accepted for the database it came from.

## Rotating secrets

| Secret | How |
|---|---|
| **Review key** (`REVIEW_API_KEY` = `TRIAGE_REVIEW_API_KEY`) | Edit the same new value into `app.env` **and** `gateway.env`, then `up -d --force-recreate app triageiq-gateway`. (`./make-secrets.sh --force` makes a new one, and new database passwords too: see next row.) |
| **Database passwords** | The passwords live inside the databases too. For each role: `docker compose -f docker-compose.prod.yml exec db sh -c 'psql -U "$POSTGRES_USER" -d postgres'` then `ALTER ROLE triageiq_app PASSWORD '<new>';` (and `gateway`; the superuser's too). Put the same new value in `db.env` and in the URL inside `app.env` / `gateway.env`, then `up -d --force-recreate`. Use letters and digits only. `make-secrets.sh --force` only rewrites the files: it does **not** change a running database. |
| **API client keys** | Create a new one with `make-client-key.ts`, add its entry to `GATEWAY_CLIENTS`, give the key to the client, remove the old entry, `up -d --force-recreate triageiq-gateway`. |
| **Anthropic / Voyage / Turnstile secret** | Make the new one at the provider, edit the file, `up -d --force-recreate app` (or `triageiq-gateway`), then revoke the old one at the provider. |
| **A reviewer's password** | `docker compose -f docker-compose.prod.yml exec -it triageiq-gateway node dist/scripts/reviewers.js set-password --email you@example.com` (ends their sessions). |

## Demo mode ("Try it as a reviewer")

A visitor (a recruiter, a curious reader) clicks **Try it as a reviewer (demo)** on the login page and gets the full review screen on **example tickets**, as a shared "Demo Reviewer", for one hour, with no account. It is a second room next to the real one:

- **Data wall.** Demo tickets are marked `is_demo` in the database. Python answers only for the scope the gateway sends (`demo` for the demo visitor, `real` for everyone else) and a ticket on the other side is a 404. Real reviewers never see demo tickets; the demo visitor never sees a real one. The gateway also keeps the visitor out of dead letters, delivery retry and the intake route.
- **Nothing is ever emailed** for a demo ticket (checked in the review route, in the delivery trigger and in the mail worker). The screen shows the email that *would* have been sent.
- A visitor can **submit a test ticket** (a real triage run with real model calls, so real cost): protected by Turnstile, a per-IP limit and its own `DEMO_DAILY_CAP` (default 20 a day). It is visible to all demo visitors until the nightly reset.
- **Reset every night at 04:00** (after the 03:30 backup): all demo tickets and their checkpoints are deleted, the 8 examples come back, and the demo sessions end. Only demo rows are ever touched.
- With `DEMO_MODE=false` (the default) every demo route is a 404 and nothing of this exists.

### Turn it on (after merging; in this order)

```bash
# 1. LAPTOP: copy the new files (demo-reset.sh, the two systemd units, the env example)
rsync -az --exclude 'env/*.env' --exclude '.env' --exclude env.local-test/ --exclude .deploy-state --exclude edge/ deploy/ contabo:/opt/triageiq/deploy/

# 2. SERVER: two new lines in the gateway settings (nano; nothing secret is new: the Turnstile secret is already there)
cd /opt/triageiq/deploy
nano env/gateway.env          # DEMO_MODE=true      DEMO_DAILY_CAP=20

# 3. SERVER: deploy the new version (the gateway migration 004 and the Python migration 0006 run by themselves)
./deploy.sh sha-<the new commit>

# 4. SERVER: put the 8 example tickets in, ONCE (no model call is made; safe to run again)
docker compose -f docker-compose.prod.yml exec app python -m app.demo.seed       # "Demo tickets: 8 added, 0 already there."

# 5. SERVER: install the nightly reset, and run it once to see it work
sudo cp systemd/triageiq-demo-reset.service systemd/triageiq-demo-reset.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now triageiq-demo-reset.timer
systemctl list-timers triageiq-demo-reset.timer
sudo systemctl start triageiq-demo-reset.service
journalctl -u triageiq-demo-reset.service -n 8 --no-pager     # "demo-reset: done"
```

`deploy.sh` refuses `DEMO_MODE=true` without a Turnstile secret. To switch the demo off: `DEMO_MODE=false`, then `./deploy.sh <tag>`. Demo tickets stay in the database, hidden; the reset timer keeps working (it only touches demo rows), or disable it: `sudo systemctl disable --now triageiq-demo-reset.timer`.

The demo user (`demo@triageiq.invalid`) appears in `reviewers list`. It has no usable password, `reviewers set-password` refuses it, and a password login for it is always refused. If you ever want it gone for good, disable it: `reviewers disable --email demo@triageiq.invalid` (the demo button then says it is not available).

**Cost to watch:** every test ticket a visitor submits is a full model run (about a cent or two). `DEMO_DAILY_CAP` bounds it per day; the public form's cap (`PUBLIC_DAILY_CAP`) is separate.

## Cost per ticket

```bash
docker compose -f docker-compose.prod.yml exec app python -m app.tools.cost_report --last 50
```

prints the average, median and maximum **estimated** cost per ticket. Prices are in `app/config.py` (with their source URLs and date); they are estimates, check the providers' invoices.

## Test it on your laptop (before the server)

```bash
deploy/local-test.sh up         # builds the three images from this checkout and starts the edge Caddy + the PRODUCTION stack, as their own projects
deploy/local-test.sh check      # routing, headers, one-hop X-Forwarded-For, log redaction, no bare names on edge (about 40 checks)
deploy/local-test.sh reviewer   # a test reviewer: tester@example.com / local-test-password-1234
# open https://triageiq.localhost:8443 (Caddy's local CA is not trusted by the browser: accept the warning); log in at /login
deploy/local-test.sh status
deploy/local-test.sh down       # removes those projects' containers, volumes and the throwaway network (not your development stack)
```

It uses fake provider keys, no Turnstile and no mail (the production guard forbids Cloudflare's test secret and Mailpit), and binds only to 127.0.0.1 (ports 8080, 8443, and 8081/3001 directly). The real `edge/` stack runs with `edge/docker-compose.local-test.yml` (Caddy's own CA instead of Let's Encrypt). Never run `docker-compose.prod.yml` without `-p` next to your development stack: the file is named `triageiq-prod` for that reason, but `local-test.sh` uses its own project names anyway.

## GitHub settings (after the first merge to `main`)

1. **Variable:** repository **Settings** > **Secrets and variables** > **Actions** > tab **Variables** > **New repository variable**: name `VITE_TURNSTILE_SITE_KEY`, value your Turnstile **site key** (public; not a secret). The publish job stops with a clear error if it is missing.
2. **First publish:** the merge to `main` runs CI; when the four checks pass, `publish-images` pushes `triageiq-app`, `triageiq-gateway` and `triageiq-web` to `ghcr.io/<owner>/` (tags `sha-<7 chars>` and `main`). Watch it under **Actions**.
3. **Package visibility (recommended: public):** your profile or organisation > **Packages** > each of the three packages > **Package settings** > **Danger Zone** > **Change visibility** > **Public**. Why public: the images contain no secrets (checked on every pull request by `deploy/tests/test-image-contents.sh`; all configuration arrives at run time from env files), the repository is a portfolio piece, and the server then needs no registry credential at all. If you make them private instead, the server needs `docker login ghcr.io` with a personal access token that has only `read:packages`, stored on the server, which is one more secret to protect and rotate.
4. Branch protection is unchanged: the four checks `python`, `gateway`, `web`, `docker-build` stay the required ones (`publish-images` runs only after merging and is not a pull request check).
