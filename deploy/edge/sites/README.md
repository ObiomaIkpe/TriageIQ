# Adding another app to the edge Caddy

Each app is one file here, `sites/<app>.caddy`, and one reload. Nothing else on the edge changes.

1. **The app's own compose project** publishes NO ports and joins the external network `edge` on exactly the service(s) the
   proxy must reach. **Name those services with the app's own prefix** (`myapp-api`, `myapp-web`): Docker makes every service name
   a DNS name on every network it joins, so a bare `web` or `api` would collide with another app's.
   ```yaml
   services:
     myapp-web:
       networks: [edge]
   networks:
     edge:
       external: true
       name: edge
   ```
2. **Add `sites/myapp.caddy`** (copy `triageiq.caddy` and cut it down):
   ```
   myapp.example.com {
   	encode zstd gzip
   	reverse_proxy myapp-web:3000
   }
   ```
   DNS for `myapp.example.com` must already point at this server (Let's Encrypt checks it).
3. **Copy the file to the server and reload** (no downtime, existing connections continue):
   ```bash
   rsync -a deploy/edge/sites/ contabo:/opt/edge/sites/
   ssh contabo 'cd /opt/edge && docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile'
   ```
   `validate` first: a typo is then reported and the running config stays as it was. The certificate is requested on the first request, or at once on reload.
