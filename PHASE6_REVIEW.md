# Phase 6 (hardening) self-review

Scope: concrete, buildable hardening items from the strategy document's pre-pilot checklist —
rate limiting, security headers, a real (if still local-dev-scoped) secrets-management
mechanism, a dependency audit, and a full regression pass — plus a written security gap
assessment. Explicitly *not* in scope: anything requiring an actual cloud deployment, a real
secrets store, or an external auditor, since none of those exist yet at this stage.

## What was verified live

- **Rate limiting**: confirmed `x-ratelimit-*` headers on a real authenticated request
  (300/min global default), and confirmed `/health` is exempted (`config: { rateLimit: false }`)
  so container health checks aren't affected by request volume from real usage.
- **Security headers (helmet)**: confirmed present on a real response (`Content-Security-Policy`,
  `X-Content-Type-Options`, `Cross-Origin-Resource-Policy`, etc.). Specifically checked that
  `Cross-Origin-Resource-Policy: same-origin` — which sounds like it should break the frontend's
  cross-origin fetch from `localhost:3000` to `localhost:4000` — doesn't, by actually loading the
  frontend in a browser and confirming data still loads. CORP governs opaque/embedded
  cross-origin loads, not CORS-mode `fetch()` with proper `Access-Control-Allow-Origin` headers;
  worth having verified this rather than assumed it, since a wrong guess here would have shipped
  a broken frontend.
- **Body size limit**: set the global Fastify `bodyLimit` one MB above the multipart file-size
  cap specifically so JSON-body limits and the CSV-upload limit don't fight each other — verified
  by re-running the ingestion upload test suite from Phase 4 afterward, still passing.
- **Configurable credentials, proven with an actual rotation**: didn't just change the config
  and assume it worked. Rotated `app_user`'s password via the new mechanism, confirmed the *old*
  password is rejected and the *new* one succeeds, using a real TCP connection through Node's
  `pg` driver (the same code path the API itself uses) — not `docker exec` psql, which turned
  out to authenticate via the Postgres image's default local-socket `trust` rule and would have
  given a false pass. Reverted to the local-dev default afterward so the running API keeps
  working.
- **Full regression suite**: `test-rls.sh`, `test-audit-chain.sh`, `test-rls-http.sh`, the Vitest
  suite, and both typechecks all re-run and passing after every change in this phase, on a
  freshly reset database (migrations 001–010 applied clean, no leftover tampered rows from
  earlier test runs).
- **Dependency audit**: `npm audit` clean (0 vulnerabilities) on both `api/` and `web/`.

## A methodology note worth keeping

The `docker exec` vs. real-TCP-connection distinction above is a specific instance of a pattern
that's shown up repeatedly across this build: **the tool used to verify something can silently
change what's actually being tested.** `docker exec psql` without `-h` uses the container's
Unix socket, which the official Postgres image trusts unconditionally for local connections
regardless of `pg_hba.conf`'s password requirements for TCP — so testing password rotation that
way would have "passed" whether or not the rotation actually worked. The fix was using the same
connection path (`pg` over TCP) that the real application uses. Same category of lesson as
Phase 0's superuser-vs-`app_user` RLS bypass and Phase 3's `docker exec` vs. concurrent-HTTP
audit race — trust the test that matches production's actual code path, not the one that's
easiest to run.

## Design choices worth flagging

- **Rate limiting is a single global default (300/min), not tuned per route.** Ingestion runs
  and case-report exports are more expensive per-request than a `/search` call; a real
  deployment would want tighter limits on the expensive routes once real usage patterns exist to
  tune against. Named rather than pretended to be finished.
- **The Keycloak client still allows both PKCE (browser) and ROPC (backend test scripts) grant
  types on one client.** This phase didn't split them — doing so would break
  `test-rls-http.sh`/`test-audit-chain.sh` without also standing up a second client and updating
  those scripts, which felt like the wrong trade to make silently inside a hardening pass. Named
  explicitly in the gap assessment (`SECURITY_GAP_ASSESSMENT.md`) as the top-priority remaining
  item instead.
- **No CI pipeline was stood up.** All the regression tests that were re-run in this phase are
  still manual/local-only. Given the existing test scripts already work and are fast, wiring
  them into GitHub Actions (or equivalent) is mechanical, not risky — flagged as the natural
  first thing to build once there's a shared repo/CI environment to build it in.

## What's fragile

- **`.env` support is convention, not enforced.** Nothing stops someone from running
  `docker compose up` or `migrate.sh` without ever creating a `.env`, silently falling back to
  the local-dev placeholders forever, including in a context that isn't actually local dev. This
  phase built the *mechanism* for real secrets; it didn't build a guardrail that fails loudly if
  the placeholders are still in use somewhere they shouldn't be (e.g., a `NODE_ENV=production`
  check that refuses to start with a `_local_dev_only`-suffixed password). Worth adding before
  any shared deployment.
- **The gap assessment is necessarily self-assessed** — the same agent that built the system
  wrote the document grading it. It's honest about that limitation in its own text, but a real
  pre-certification gap assessment needs an independent reviewer, not just an honest one.

## Deferred, and why

Everything in `SECURITY_GAP_ASSESSMENT.md`'s "prioritized gaps" list beyond what was fixed this
phase — CI automation, retention enforcement, DPIA tooling, monitoring/alerting, the Keycloak
client split — is real, scoped, and intentionally left for the next pass rather than attempted
partially inside this one.
