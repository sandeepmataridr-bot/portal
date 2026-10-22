# Deployment

Single-VPS deployment via Docker Compose. One public origin — Caddy (the
`web` container) terminates TLS and is the only container exposed to the
internet; `api`, `postgres`, and `redis` are reachable only on the internal
compose network.

Same-origin is a hard requirement, not a preference: the refresh-token
cookie is `SameSite=Strict`. A split-subdomain deploy (e.g. `app.example.com`
+ `api.example.com`) would silently stop the browser from ever sending that
cookie back. `web`'s Caddyfile (`infra/docker/Caddyfile`) proxies `/api/*` to
the `api` container, stripping the prefix — so `apps/api`'s routes stay
unprefixed (`/auth/login`, not `/api/auth/login`) and the frontend talks to
`/api/*` on the same origin as the static site.

## One-time setup

1. Point DNS (A/AAAA) for your domain at the VPS before starting — Caddy
   requests a Let's Encrypt cert on first boot and will loop/fail without
   live DNS.
2. `cp infra/docker/.env.prod.example infra/docker/.env.prod` and fill in:
   - `DOMAIN` — the public domain.
   - `POSTGRES_PASSWORD` — generate with
     `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — two **different** 32+ char
     secrets, generate each with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Never commit `infra/docker/.env.prod` (gitignored already).
4. Leave `TEST_LOGINS=false` unless this is a TEST-mode demo whose login
   page is itself protected (e.g. Cloudflare Access). When on, the login
   screen lists ready-made accounts for every role, admin included, with
   their passwords. It is ignored in Vigil LIVE mode, and start-up disables
   those accounts whenever it is off.

## Deploy

```sh
cd infra/docker
docker compose -f docker-compose.prod.yml --env-file .env.prod build
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate pnpm run db:seed   # first deploy only
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

Migrations are **never** run automatically on `api` container boot — always
run `migrate` explicitly, once, before `up -d`. This avoids two things a
medical system can't tolerate silently: multiple replicas racing on
`migrate deploy`, and a bad migration blocking every future container start
instead of failing loudly in a controlled step you're watching.

`db:seed` creates the initial admin/reception/pharmacy/insurance/doctor
accounts with forced-change temp passwords — run it once against a fresh
database, never against one with real data.

## Updating

```sh
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod build
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate   # only if this release adds migrations
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

## Verifying a deploy

```sh
curl -s https://$DOMAIN/api/health                 # {"status":"ok"}
curl -sI https://$DOMAIN/ | grep -i -E 'strict-transport|content-security-policy|x-frame-options'
curl -sI https://$DOMAIN/api/health | grep -i cache-control   # no-store
docker compose -f docker-compose.prod.yml ps        # all healthy
```

## Security headers

`infra/docker/Caddyfile` adds them to every response: HSTS, a strict
Content Security Policy (this site's own scripts, styles, fonts, images and
API/socket only, no third parties, no framing), X-Frame-Options, nosniff,
Referrer-Policy, Permissions-Policy, cross-origin isolation of the window and
resources, `Cache-Control: no-store` on `/api`, `X-Robots-Tag: noindex` on
everything but the landing page, and no `Server` header. If the web app ever
loads something from another origin (or Cloudflare features that inject
scripts, like Web Analytics), add that origin to the CSP and check the
browser console for CSP violations.

## Data & backups

- `pgdata`, `redisdata`, `caddy_data` (TLS certs), `caddy_config` are named
  Docker volumes — back up `pgdata` at minimum (`docker compose exec
  postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB`).
- `caddy_data` holds the Let's Encrypt cert/key — losing it just costs a
  re-issuance (rate-limited by Let's Encrypt, ~50/week/domain), not data.

## Load/soak test

This is an internal hospital-coordination dashboard — a handful of staff
terminals, not internet-scale traffic — and every route is already
rate-limited (100 req/min/IP default, tighter on auth endpoints). So the
meaningful test is sustained realistic concurrent use + stability, not
synthetic max-throughput blasting (which the throttle would just reject by
design). Ran two consecutive 2-minute soaks, 8 virtual users polling
`/machines/fleet-status`, `/patients`, `/patients/dashboard`, `/medicines`,
`/medicines/dashboard`, `/insurance/claims`, `/doctors` at randomized
1-3s intervals each (against the dev server — `nest start`, unoptimized
relative to the production `node dist/main.js` build):

| Run | Requests | Errors | p50 / p95 / p99 (ms) | Server RSS |
|---|---|---|---|---|
| baseline | — | — | — | 22.6 MB |
| 1 | 474 | 0 | 21.5 / 36.0 / 119.4 | 75.7 MB (+53.1) |
| 2 | 487 | 0 | 21.4 / 32.6 / 42.4 | 78.3 MB (+2.6) |

Zero non-2xx responses across both runs; p99 *improved* on the second run
(JIT/module warmup, not degradation). Memory grew ~53MB on the first run
(process warmup — module loading, connection pools, V8 heap sizing to a
working set) then only ~2.6MB on an equivalent second run — a real
per-request leak would show comparable growth in both runs, not a ~20x
smaller delta on the second. No leak indicated.

## Known deferred items (see also `SECURITY.md`)

- `react-router@6.30.6` (apps/web) has two low-severity moderate CVEs fixed
  only in the 7.x major. Not exploitable in this app's current usage (no SSR,
  no user-controlled navigation targets) — deferred, not silently ignored.
- No horizontal scaling story yet — `api` is a single replica. BullMQ/Redis
  and the DB would both need to support it (they already would); the compose
  file itself would need a `deploy.replicas` + load-balancing story added
  before that's safe.
