# Security notes

Manual security review performed for M6 (the `/security-review` skill could
not target this repo in this environment — it's pinned to the harness's
fixed working directory, a sibling repo — so this was a manual pass:
grep-based checks + `pnpm audit`, both re-verified against the built
production Docker image, not just source).

## Reviewed and clean

- No raw/string-concatenated SQL (Prisma parameterizes everything).
- No `dangerouslySetInnerHTML`, no `eval`/`new Function`.
- No hardcoded secrets in source (all via env, validated at boot by
  `apps/api/src/config/env.validation.ts` — the app refuses to start
  without real `JWT_*_SECRET` values ≥32 chars).
- Deny-by-default RBAC (`RolesGuard`) — every route requires `@Roles(...)`
  or `@Public()`; an undecorated route is rejected, not silently open.
- Swagger/OpenAPI (`/api/docs`) is gated to non-production
  (`apps/api/src/main.ts`) — the full route/DTO schema isn't handed to an
  attacker for free in prod.
- Rate limiting (`@nestjs/throttler`) on every credential/token-issuing
  endpoint: login (10/min), refresh (20/min), change-password (10/min),
  doctor password reset (10/min), machine credential issuance (10/min) — on
  top of the account-level lockout (5 failed logins / 15min) in
  `AuthService`, which is IP-independent.
- Password minimum length raised from 8 to 12 chars
  (`packages/shared-types/src/auth.schema.ts`) — NIST SP 800-63B favors
  length over composition rules.
- Insurance claim `status` query filter is validated against the real enum
  before it reaches Prisma (`InsuranceController.listClaims`) — previously
  a bad value fell through to a raw cast and a 500, not a clean 400.
- Refresh-token cookie is `httpOnly`, `Secure` in production, `SameSite=Strict`,
  path-scoped to `/auth` (or `/api/auth` behind the prod reverse proxy —
  see `REFRESH_COOKIE_PATH` in `env.validation.ts` and
  `docs/deployment.md`). Verified end-to-end through the actual prod Docker
  Compose stack (built, migrated, and curled through Caddy+TLS locally)
  that the cookie round-trips correctly — this was a real bug caught by that
  verification, not by review: the reverse proxy strips `/api`, and the
  cookie path has to reflect the public path the browser sees, not the
  api's internal route, or refresh/logout silently break in prod only.

## `pnpm audit` findings — reviewed individually, none block deployment

10 findings (1 critical, 2 high, 7 moderate) as of 2026-09-17. All investigated
for actual reachability, not just severity label:

| Package | Severity | Ships in prod image? | Reachable at runtime? | Disposition |
|---|---|---|---|---|
| `vitest`, `@vitest/mocker`, `vite`, `esbuild` | critical/high/moderate | No — `vitest`/`vite` are devDependencies of `apps/web`/`packages/shared-types`, never installed by `apps/api`'s `pnpm deploy --prod`, and `apps/web`'s Dockerfile only ships the static `dist/` build output, not `node_modules` | No | Deferred — dev-tooling only, zero production exposure |
| `deepmerge-ts` (via `@prisma/config` via `prisma`) | high | **Yes** — confirmed present in the built `apps/api` runtime image (`docker run --rm --entrypoint sh infusion-api:test -c "find / -iname deepmerge-ts"`) | No — `prisma` is only an *optional peer dependency* of `@prisma/client`; pnpm resolves it into the image because `apps/api` also lists `prisma` as a devDependency (needed for `prisma generate`/`migrate`), but the app's own code (`grep`-verified) never imports `prisma` or `@prisma/config`. The vulnerable code (stack exhaustion in `@prisma/config`'s recursive merge, used only when the `prisma` CLI loads a config file) is dead weight on disk, not on the request path — `node dist/main.js` never touches it. | Deferred, verified non-exploitable in this deployment. Not silently assumed — actually checked inside the built image, not just reasoned about from the dependency graph. |
| `react-router` (2 CVEs: open-redirect via backslash, arbitrary-constructor-injection via SSR hydration `deserializeErrors()`) | moderate | Yes — `react-router-dom` is a real `apps/web` runtime dependency | No — grepped every `navigate(`/`to=` call site in `apps/web/src`; every target is a hardcoded string or a fixed internal role→route lookup, never user-controlled input, so the open-redirect has no attacker-controlled input to exploit. The SSR-hydration CVE doesn't apply architecturally — this is a pure Vite CSR app, no server-side rendering, `deserializeErrors()`'s code path is never invoked. | Deferred. No patched 6.x release exists (fix is 7.18.0+, a breaking major migration) — rushing that under deployment time pressure, without dedicated retesting of every route/guard/redirect, is a worse trade than shipping the current, verified-non-exploitable 6.30.6. Revisit as a planned migration, not a hotfix. |

Re-run `pnpm audit` before every release and re-verify this table hasn't gone
stale — a new react-router-dependent feature that DOES accept user input into
a navigation target would change the open-redirect row's conclusion.

## Known accepted gaps (not vulnerabilities, scope/roadmap notes)

- No WebSocket-driven live updates are wired up in `apps/web` yet
  (`socket.io-client` is installed but unused) — dashboards poll via React
  Query. Not a security issue, just an incomplete feature from the original
  plan's "live fleet status" goal.
- Single `api` replica, no horizontal scaling — see `docs/deployment.md`.
