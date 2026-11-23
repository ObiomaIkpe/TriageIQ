# Deploying TriageIQ (runbook)

Everything the server needs is in this folder. The server does **not** need the source code: it pulls three images from GitHub's container registry and starts them with `docker-compose.prod.yml`.

```
deploy/
  docker-compose.prod.yml        the production stack (db, redis, app, gateway-migrate, gateway, web)
  docker-compose.local-test.yml  an override to test that stack on your laptop (see "Test it on your laptop")
  .env.example                   TAG and GHCR_OWNER (copy to .env)
  env/*.env.example              the settings, one file per service (copy to env/*.env, which git ignores)
  make-secrets.sh                fills fresh random passwords and keys, never printing them
  backup.sh  restore.sh          nightly dump of both databases, and restoring one of them
  systemd/                       the nightly timer
  db/                            the database init scripts (a copy of ../db; deploy/sync-db-sql.sh keeps it in step)
  Caddyfile.edge-snippet.example the lines for the shared edge Caddy
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
- Memory limits (4 GB host): db 512 MB, redis 128 MB (it also refuses writes above 96 MB; BullMQ needs `noeviction`), app 512 MB, gateway 384 MB, web 64 MB. That is **1.6 GB** if every service sits at its limit; idle on the laptop they use about 0.3 GB. The one-shot `gateway-migrate` may use 256 MB for a few seconds. About **2.4 GB** is left for Ubuntu, the edge Caddy and one more small app. A service over its limit is killed and restarted by Docker; it cannot take the host down.
- Logs: `json-file`, 10 MB x 3 files per container.
- The edge Caddy's lines are in `Caddyfile.edge-snippet.example`.

## Before the first install (once)

1. **Server:** Ubuntu 24.04, Docker with the compose plugin, the `edge` network and the edge Caddy running:
   ```
   docker network create edge
   ```
   Add the `triageiq.bamstoneopus.com` block from `Caddyfile.edge-snippet.example` to the edge Caddy and reload it. DNS: an A record for `triageiq.bamstoneopus.com` to the server.
2. **Cloudflare Turnstile:** create a widget for the hostname `triageiq.bamstoneopus.com`. You get a **site key** (public) and a **secret key** (private).
3. **GitHub (after the first merge, see "GitHub settings")**: the repository variable `VITE_TURNSTILE_SITE_KEY`, and the visibility of the three packages.
4. **Anthropic and Voyage keys** for the server (new ones, not the ones on your laptop).

## First install

On your laptop, copy the folder to the server (only `deploy/`):

```bash
rsync -az --exclude env.local-test --exclude 'env/*.env' --exclude .env deploy/ contabo:/opt/triageiq/deploy/
```

On the server:

```bash
cd /opt/triageiq/deploy
cp .env.example .env            # edit TAG (see "Update") and GHCR_OWNER if your account name differs
./make-secrets.sh               # creates env/db.env, env/app.env, env/gateway.env with random passwords and keys
```

`make-secrets.sh` prints only which names it set. It tells you what is still left to fill **by hand**:

```bash
nano env/app.env        # ANTHROPIC_API_KEY, VOYAGE_API_KEY
nano env/gateway.env    # TURNSTILE_SECRET_KEY; check ALLOWED_ORIGINS and TURNSTILE_EXPECTED_HOSTNAMES; MAIL_ENABLED stays false until M6c
```

Create **new** API client keys with the gateway image's script. **The old keys were exposed and must never be reused.** The script prints a key once (give it to the client; store it in a password manager) and the line to paste:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml run --rm --no-deps gateway node scripts/make-client-key.ts web-form submitter
docker compose -f docker-compose.prod.yml run --rm --no-deps gateway node scripts/make-client-key.ts ops-reviewer reviewer
nano env/gateway.env    # replace the placeholder inside GATEWAY_CLIENTS with the printed entries (a JSON array, one line, single quotes)
```

Start it:

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps          # wait until app, gateway, web, db and redis say (healthy)
docker compose -f docker-compose.prod.yml logs gateway | tail
```

If the gateway or the app stops at once with `Refusing to start in production: ...` or `Invalid gateway configuration: ...`, that is the production guard: the message names the setting that is wrong (never its value). Fix `env/*.env` and run `up -d` again.

Then, once:

```bash
# the knowledge base (this makes Voyage calls, which cost a little; with VOYAGE_RPM=3 it takes about a minute)
docker compose -f docker-compose.prod.yml exec app python -m app.kb.ingest
# a reviewer account (asks for a password; typed twice, hidden)
docker compose -f docker-compose.prod.yml exec -it gateway node dist/scripts/reviewers.js create --email you@example.com --name "Your Name"
# smoke tests, from anywhere
curl -s https://triageiq.bamstoneopus.com/api/health        # {"status":"ok"}
curl -sI https://triageiq.bamstoneopus.com/ | grep -i content-security-policy
```

Open `https://triageiq.bamstoneopus.com/login`.

## Update to a new version (a new TAG)

Every merge to `main` publishes images tagged `sha-<first 7 characters of the commit>` and `main`. Use the exact `sha-...` tag (the Actions run, or the package page, shows it); `main` moves under you.

```bash
cd /opt/triageiq/deploy
./backup.sh                                       # a fresh backup first (see "Backups")
nano .env                                         # TAG=sha-1a2b3c4
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d   # only changed services are recreated; the gateway migrations run first
docker compose -f docker-compose.prod.yml ps
```

The Python service applies its own Alembic migrations when it starts; the gateway's run in the one-shot `gateway-migrate` service. The gateway waits (up to its 130 s stop grace) for a running job to finish when it is stopped.

## Roll back

```bash
nano .env                                         # TAG=<the previous sha-...>
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Images roll back; **databases do not** (migrations only go forward). Migrations in this project add nullable columns and tables, which an older image ignores, so rolling back one version is normally safe. If a release changed the schema in a way an older image cannot live with, restore the backup you took before the update (below) after stopping `app` and `gateway`.

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
docker compose -f docker-compose.prod.yml stop gateway app        # the script refuses while they run
./restore.sh /var/backups/triageiq/2026-11-23/triageiq.dump        # asks you to type the database name
docker compose -f docker-compose.prod.yml up -d
```

The gateway database restores the same way (`gateway.dump`; only `gateway` needs to be stopped). A dump is only accepted for the database it came from.

## Rotating secrets

| Secret | How |
|---|---|
| **Review key** (`REVIEW_API_KEY` = `TRIAGE_REVIEW_API_KEY`) | Edit the same new value into `app.env` **and** `gateway.env`, then `up -d --force-recreate app gateway`. (`./make-secrets.sh --force` makes a new one, and new database passwords too: see next row.) |
| **Database passwords** | The passwords live inside the databases too. For each role: `docker compose -f docker-compose.prod.yml exec db sh -c 'psql -U "$POSTGRES_USER" -d postgres'` then `ALTER ROLE triageiq_app PASSWORD '<new>';` (and `gateway`; the superuser's too). Put the same new value in `db.env` and in the URL inside `app.env` / `gateway.env`, then `up -d --force-recreate`. Use letters and digits only. `make-secrets.sh --force` only rewrites the files: it does **not** change a running database. |
| **API client keys** | Create a new one with `make-client-key.ts`, add its entry to `GATEWAY_CLIENTS`, give the key to the client, remove the old entry, `up -d --force-recreate gateway`. |
| **Anthropic / Voyage / Turnstile secret** | Make the new one at the provider, edit the file, `up -d --force-recreate app` (or `gateway`), then revoke the old one at the provider. |
| **A reviewer's password** | `docker compose -f docker-compose.prod.yml exec -it gateway node dist/scripts/reviewers.js set-password --email you@example.com` (ends their sessions). |

## Cost per ticket

```bash
docker compose -f docker-compose.prod.yml exec app python -m app.tools.cost_report --last 50
```

prints the average, median and maximum **estimated** cost per ticket. Prices are in `app/config.py` (with their source URLs and date); they are estimates, check the providers' invoices.

## Test it on your laptop (before the server)

```bash
deploy/local-test.sh up         # builds the three images from this checkout, starts the PRODUCTION stack as its own project
deploy/local-test.sh reviewer   # a test reviewer: tester@example.com / local-test-password-1234
# open https://localhost:8443 (self-signed certificate: accept the warning); log in at /login
deploy/local-test.sh status
deploy/local-test.sh down       # removes that project's containers, volumes and networks (not your development stack)
```

It uses fake provider keys, no Turnstile and no mail (the production guard forbids Cloudflare's test secret and Mailpit), and binds only to 127.0.0.1. A small Caddy (`edge-sim`) plays the edge stack, with the same `/api` rule. Never run `docker-compose.prod.yml` without `-p` next to your development stack: the file is named `triageiq-prod` for that reason, but `local-test.sh` uses its own project name anyway.

## GitHub settings (after the first merge to `main`)

1. **Variable:** repository **Settings** > **Secrets and variables** > **Actions** > tab **Variables** > **New repository variable**: name `VITE_TURNSTILE_SITE_KEY`, value your Turnstile **site key** (public; not a secret). The publish job stops with a clear error if it is missing.
2. **First publish:** the merge to `main` runs CI; when the four checks pass, `publish-images` pushes `triageiq-app`, `triageiq-gateway` and `triageiq-web` to `ghcr.io/<owner>/` (tags `sha-<7 chars>` and `main`). Watch it under **Actions**.
3. **Package visibility (recommended: public):** your profile or organisation > **Packages** > each of the three packages > **Package settings** > **Danger Zone** > **Change visibility** > **Public**. Why public: the images contain no secrets (checked on every pull request by `deploy/tests/test-image-contents.sh`; all configuration arrives at run time from env files), the repository is a portfolio piece, and the server then needs no registry credential at all. If you make them private instead, the server needs `docker login ghcr.io` with a personal access token that has only `read:packages`, stored on the server, which is one more secret to protect and rotate.
4. Branch protection is unchanged: the four checks `python`, `gateway`, `web`, `docker-build` stay the required ones (`publish-images` runs only after merging and is not a pull request check).
