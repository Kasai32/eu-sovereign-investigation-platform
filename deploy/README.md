# Deployment (Phase 5 / PRD v1.1 B7)

## What this is, and isn't

This is a **one-off, budget-constrained interim deployment** — the full stack (Postgres,
Keycloak, API, web) running in Docker on a personal machine (a Mac Mini/Air, in this case),
made reachable from the public internet through a free [Cloudflare quick
tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/),
for exactly as long as `deploy/run-ephemeral-demo.sh` is left running.

It is **not** the intended production deployment. The PRD's actual target is a real EU cloud
host (Hetzner Cloud was the specific recommendation — German-owned, cheap, sovereignty-aligned)
with a stable domain and TLS via a real certificate, not a rotating `*.trycloudflare.com`
hostname. This exists because that costs a small monthly amount this project didn't have
available yet; revisit once it does. Everything here — the Dockerfiles, the Caddy reverse-proxy
config, the secrets-from-env pattern — carries over directly to that move; only the tunnel step
and the personal-machine hosting go away.

## Running it

```bash
# cloudflared must be on PATH, or set CLOUDFLARED_BIN to its path
bash deploy/run-ephemeral-demo.sh
```

This, in order:
1. Generates fresh random secrets into `.env.deploy` (gitignored — never the checked-in dev
   placeholders from `005_roles_and_rls.sql`).
2. Starts Postgres, applies all migrations, loads synthetic seed data.
3. Starts a Cloudflare quick tunnel pointed at `localhost:8000` and captures its assigned URL.
4. Builds the web image with that URL baked into the static bundle (Vite's `VITE_*` env vars
   are build-time, not runtime — see `web/Dockerfile`), and patches a throwaway copy of
   `keycloak/realm-export.json` (`keycloak/realm-export.deploy.json`, gitignored) with the
   tunnel origin as the client's allowed redirect URI/web origin.
5. Starts Keycloak (hostname pinned to the tunnel's, so it stamps tokens with the right
   issuer) and the API (pointed at that same issuer), then Caddy — the single container that
   serves the built web app *and* reverse-proxies `/api/*` and Keycloak's browser-facing
   endpoints, all from the one port the tunnel exposes. Same origin end to end, so there's no
   CORS to configure for whatever hostname a fresh tunnel gets assigned.
6. Prints the reachable URL. Sign in with any seed user (e.g. `sam.supervisor` /
   `devpassword123`).

Run `bash deploy/teardown.sh` when done — stops the tunnel, stops and removes the containers
and network, deletes `.env.deploy` and `keycloak/realm-export.deploy.json`. Keeps the Postgres
volume (`pgdata_prod`) by default so a re-run doesn't need reseeding; pass `--wipe-data` to drop
that too. **Nothing here is meant to be left running unattended** — it's a session, not a
service.

## What's exposed, and what isn't

Only Caddy (the `web` service) publishes a host port. Postgres, Keycloak, and the API are
reachable only over the internal compose network — the tunnel, and therefore the public
internet, never sees them directly, only what Caddy chooses to proxy.

## Real problems this surfaced, not assumed

Three genuine bugs, only found because this was actually run and clicked through, not just
configured and assumed correct — see `DECISIONS.md` #47 for the full account:

- **`api`'s own `start` script never worked.** `node --experimental-strip-types` strips type
  syntax but does not resolve TypeScript's `.js`-suffixed relative imports back to `.ts` files
  the way `tsx` does — every prior phase only ever exercised `npm run dev` (`tsx watch`), never
  `npm start`. Fixed: `start` now runs `tsx` directly too, matching `dev` minus the file-watcher.
- **Reusing the dev-stack directory for a second Compose file, without giving it its own
  project name, made Compose treat both as one project.** The first run of this deploy script
  silently recreated (and detached from) the running dev `platform_postgres`/`platform_keycloak`
  containers under the new file's config — the dev Postgres volume survived only because Compose
  doesn't drop named volumes on a service recreate, not because anything prevented the mistake.
  Fixed with an explicit `name: platform-demo` in `docker-compose.prod.yml`, isolating it from
  `docker-compose.yml` regardless of directory. **If you ever copy this compose file's pattern,
  keep that line** — it's the only thing standing between two stacks and one merged project.
- **Keycloak generated `http://` login-form action URLs on an `https://` page**, which Chrome
  correctly refused to submit as insecure mixed content. Cloudflare's tunnel terminates TLS at
  its edge; the hop from cloudflared to Caddy, and from Caddy to Keycloak, is plain HTTP —
  Keycloak assumed that local scheme was the real one. Fixed by having Caddy explicitly tell
  Keycloak `X-Forwarded-Proto: https` for the paths it proxies to it (`web/Caddyfile`), which
  `--proxy-headers=xforwarded` (`docker-compose.prod.yml`) then trusts.

## Next steps (once budget allows)

1. Provision a Hetzner Cloud VM (their cheapest tier comfortably fits this stack).
2. Point a real domain at it; Caddy gets automatic HTTPS from a real cert for free, no tunnel.
3. Same Dockerfiles, same `docker-compose.prod.yml` shape, same secrets-from-`.env` pattern —
   swap the tunnel step for the domain, and decide whether the deployment should be long-running
   there (systemd unit / restart policy) rather than a manually-launched session.
4. Backups + a verified restore drill (Phase 6 / PRD v1.1 B7 part 2) — not yet done.
