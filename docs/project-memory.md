# Project memory / build log

> **Provenance note**: this is a project-colocated copy of Claude Code's auto-memory file for this project
> (`C:\Users\rpava\.claude\projects\i--infusion-server\memory\infusion_platform_rebuild.md`). The harness's
> memory subsystem is pinned to that fixed path on `C:\` and cannot be technically redirected — this copy
> exists so the build history is git-tracked and lives on `I:\` alongside the code it describes, per the
> "never use C:\ for project data" rule. Future sessions' auto-memory will keep writing to the C:\ file; if
> that file changes meaningfully, re-sync this copy from it.

Building a new hospital infusion-pump fleet management system ("infusion-platform") from scratch, using `I:\infusion_server` (the Flask/Python app) only as a functional/domain spec — not migrated or preserved structurally, and never to be edited. Full approved plan lives in this same directory at `docs/plan.md` (project copy) / `C:\Users\rpava\.claude\plans\understand-this-project-compressed-wirth.md` (harness original) — read it first when resuming this work; it's the source of truth for the data model, module breakdown, and phased milestones M1–M6 plus the M7 extension.

**Architecture**: fleet-dashboard model. Each infusion pump machine is a fully autonomous edge controller (own data, own safety/control logic, own credentials) that can run a patient's infusion with zero network connectivity — the server being unreachable never stops treatment. The new server is the fleet's dashboard + master registry, not the enforcement authority: it holds the shared patient/doctor/medicine registry and pushes changes to machines as sync proposals; machines accept/reject locally ("server proposes, machine decides"). Sync is machine-initiated (the machine calls home when it has connectivity), not the server pushing inbound webhook calls to a device.

**Locked tech stack decisions**:
- Frontend: React + TypeScript (Vite), React Router, TanStack Query, React Hook Form + zod, Socket.IO client
- Backend: NestJS (TypeScript), Prisma + PostgreSQL, Socket.IO gateway, argon2, JWT, @nestjs/throttler, Helmet
- Sync/jobs: Redis + BullMQ (proposal delivery/retry)
- Shared: a zod-based `shared-types` package (server DTOs + frontend forms + sync-contract doc source), OpenAPI/Swagger
- Monorepo: pnpm workspaces + Turborepo
- Testing: Jest + Supertest, React Testing Library, a simulated-machine test harness for sync scenarios
- Infra: Docker Compose, Caddy/Traefik reverse proxy (TLS), Cloud VPS hosting, GitHub Actions CI
- Historical data: start clean, no migration from the old `pharmacy.db`/`patient_data/*.txt`
- The Android pump-controller app itself is out of scope for this build — only `docs/sync-contract.md` (the protocol it must implement against) is produced here

**Safety/security requirements**: strict RBAC, deny-by-default, 5 roles (admin/doctor/reception/pharmacy/insurance) each with a hard permission boundary (full matrix in the plan), plus enforced workflow ordering — patient registration → machine tagging → doctor order → pharmacy verification → high-alert dual-confirm → execution; insurance claims can't skip status states — checked server-side at the service layer, never just hidden in the UI. Dosage/rate caps come from new `medicines` fields not present in the reference (`max_flow_rate_ml_per_h`, `max_single_dose_ml`, `absolute_max_flow_rate_ml_per_h`).

**Why**: user wants this "more secure, more responsive, more interlocking" than the reference app, which has confirmed security bugs (machine-auth silently allows requests when no `api_key` is configured, HMAC+shared-pepper hashing instead of bcrypt/argon2, `SESSION_COOKIE_SECURE=False`, secrets stored as plaintext files in the repo root, hardcoded default credentials) and no real dosage-cap enforcement anywhere despite storing a `high_alert` flag.

**How to apply**: new project code lives at `I:\infusion_platform`, a sibling directory to `I:\infusion_server`, never nested inside or overwriting it. The exact UI (every field label, button, table column, modal, and status badge across reception/doctor/pharmacy/insurance/admin/control/settings/machines/login/manage_doctors pages) was fully catalogued during planning — re-derive it from the reference templates again if needed rather than guessing, since the user wants the same UI/functionality preserved.

**Scope boundary, confirmed after initial planning**: this repo is the flow-management/coordination website only — NOT machine design/development. The physical machines (infusion pumps, ECMO, EBOO) are a separate engineering effort with their own device-side control/safety logic. The website's job is keeping the shared registry consistent and catching/surfacing conflicts across roles and across a patient's multiple simultaneous machines, never commanding a machine directly.

**Fleet is multi-machine-type, not infusion-only** (added after initial approval): `Machine` has a `machineType` (`INFUSION_PUMP` | `ECMO` | `EBOO`, extensible) and stays deliberately type-agnostic (registration/connectivity/credentials only) — each type gets its own domain module with typed tables, `InfusionModule` being the only one fully built so far ("framework now, specifics later" — ECMO/EBOO get real clinical fields once specified). Patient↔Machine is many-to-many via `PatientMachineAssignment` (a patient can be on ECMO + an infusion pump at once), not the reference's single FK. **Sync directionality is per machine type**: `INFUSION_PUMP` is bidirectional (server proposes via `sync_outbox`, machine decides); `ECMO`/`EBOO` are unidirectional (push-only telemetry, no proposals ever queued for them, operated directly at the bedside).

**Environment note for future sessions**: everything for this project (pnpm store/cache/state, npm cache, node_modules, all project files) is pinned to the `I:\` drive — never `C:\`, per explicit user instruction, "not even for temp files." `pnpm config get store-dir/cache-dir/state-dir` should all resolve under `I:\`. Docker Desktop is installed and working (`docker compose -f infra/docker/docker-compose.yml up -d` brings up local Postgres+Redis, both healthy).

**M1 status: AuthModule is built and verified working end-to-end.** Login/refresh/logout/change-password, argon2id hashing, JWT access + rotating opaque refresh tokens (httpOnly cookie), brute-force lockout (5 attempts/15min), deny-by-default RBAC (`JwtAuthGuard` + `RolesGuard`, every route needs `@Public()` or `@Roles()`) — all manually verified against the live Postgres via curl (login, refresh rotation + old-token-reuse-rejection, password-change revokes other sessions, lockout after 5 failed attempts, unclassified/unauthenticated routes correctly denied). Seed script (`pnpm run db:seed` in apps/api) creates one dev user per role, `mustChangePassword: true`. Initial Prisma migration (`20260917025850_init`) applied.

**M2 status: DoctorsModule, MachinesModule, PatientsModule built and verified live.** Admin-managed doctor accounts (create/update/archive/reset-password, auto-generated loginId+random temp password, never a fixed default like the reference's "Doctor@123"). Machine registry + fleet status (`GET /machines/fleet-status` → total/connected counts). Patient register/discharge/readmit/clinical-update, each writing a versioned `PatientHistory` snapshot. **Multi-machine tagging confirmed working exactly as designed**: same patient tagged to both an INFUSION_PUMP (bidirectional → `syncStatus: pending_machine_ack`) and an ECMO (unidirectional → `syncStatus: accepted`) simultaneously; tagging a machine already assigned to a *different* patient correctly 409s. RBAC confirmed denying doctor role from patient registration (403). Two new migrations applied (`add_doctor_profile_name`, `add_insurance_type`); seed script now also creates two dev machines (PUMP-001, ECMO-001).

**M3 status: MedicinesModule (+ medicine requests) and InsuranceModule built and verified live.** Pharmacy inventory dashboard, stock-in/stock-out with server-computed GST (never trusts client-sent totals), insurance-payment gating (blocked unless the patient's claim is `approved`, confirmed both directions live). Medicine now has `batchNo`/`expiryDate` (reference had these, M1's schema pass missed them — added via migration). Insured patient registration auto-creates a `draft` InsuranceClaim. Insurance decision workflow (Approve/Partially Approve/Reject/Request Documents) with the exact 20 R001–R020 rejection reason codes from the reference, correctly restricted to actionable statuses; revoke correctly restricted to `partially_approved`/`rejected` only (confirmed `approved` claims are NOT revocable, matching the reference's "Locked" behavior exactly). Every claim decision writes a versioned `PatientHistory` entry (`INSURANCE_APPROVED` etc.), confirmed live. Doctor medicine-request → pharmacy fulfill/reject flow confirmed live.

**M4 status: InfusionsModule built — the safety-critical core, fully live-verified.** `InfusionCapService` (wraps the M1 unit-tested `checkInfusionCaps`) + `InfusionStepStateMachineService` (wraps `assertStepTransition`, records `InfusionStepEvent` atomically) + `InfusionsService` orchestrating the full order/step lifecycle. A real bug was caught and fixed by live testing (not typecheck): `verifyDispense` originally tried to jump straight from `PENDING_PHARMACY_VERIFICATION` to `READY`, skipping the required `PHARMACY_VERIFIED` intermediate state — fixed to chain two transitions. Confirmed live: cap violation blocks order creation (400); skipping the workflow (e.g. starting a DRAFT step) returns 409 `STEP_TRANSITION_INVALID`; pharmacy dispensing the wrong medicine/volume returns 409 `DISPENSE_MISMATCH`; high-alert medicines route through `PENDING_SECOND_CONFIRMATION` and reject same-actor confirmation (403) while a distinct actor succeeds; full non-high-alert lifecycle (verify→start→pause→resume→complete) works with `InfusionLiveStatus` updating correctly at each step; override endpoint works and re-checks the absolute cap ceiling (confirmed via lowering a medicine's cap after step creation — order creation for a new step at the old rate was then correctly re-blocked). `InvalidStepTransitionFilter` maps the shared `InvalidStepTransitionError` to a proper 409 globally.

**M5 status: SyncModule built — ALL backend modules from the original plan complete.** `MachineCredentialsService` (issue/rotate, hashed like refresh tokens) + `MachineAuthGuard` (hard 401 on missing/invalid credentials — the direct, confirmed-live fix for the reference's silent-bypass bug) + `SyncService` (REST pull/push, the guaranteed primary channel) + `SyncOutboxService` (enqueues proposals, schedules a BullMQ delivery-attempt job) + `SyncGateway` (Socket.IO, machine + dashboard rooms) + `SyncDeliveryProcessor` (BullMQ worker, opportunistic WS push, no-ops if REST pull already got there first). Outbox enqueueing wired into `MachinesService.assignPatientToMachine` and `InfusionsService.submitOrder`.

**Full "server proposes, machine decides" cycle verified live**: missing/wrong machine credentials → 401 (both tested); admin issues a credential; machine pulls and receives the queued proposal (marked `delivered`); machine pushes an `accepted` report; server correctly marks the outbox entry `acked`, updates `PatientMachineAssignment.syncStatus` to `accepted`, and writes the `SyncInboxLog` row. Confirmed the REST-pull-wins-the-race behavior is intentional: the BullMQ job (3s delayed) correctly no-ops when it finds the entry already `delivered` via REST, exactly as designed (pull is the guaranteed path, WS is a latency optimization, never a replacement). All ~40 routes across every module registered cleanly on a clean boot with zero DI errors.

**Gap-fill pass, all verified live**: login-specific rate limiting (`@Throttle` 10/min on `/auth/login`, distinct from the per-account 5-attempt lockout — confirmed 429s kick in after the 7th rapid request); `GET /patients/dashboard` (reception stat tiles); `GET /doctors/:id/history` (admin-only activity audit trail); `GET /patients?doctorId=` filter. **Two deliberate scope decisions made, not oversights**: (1) the reference's doctor "suggest medicine" feature is treated as superseded by the more rigorous `InfusionOrder`/`InfusionStep` system built in M4 — not rebuilt as a parallel path. (2) Editing individual steps on an existing `DRAFT` order isn't implemented — only whole-order create is.

**Frontend build: all 5 role dashboards (Reception, Doctor, Pharmacy, Insurance, Admin) complete and browser-verified.** Every dashboard was driven end-to-end with real Playwright browser automation (not just typecheck/curl). **Full bug tally caught only by browser-testing, none by typecheck/curl** (worth remembering as the concrete case for why live browser verification matters): (1) `AuthService.changePassword` revoked the acting session's own refresh token, causing a redirect loop on the change-password flow — fixed to exclude/rotate only that session's token and adopt the fresh session client-side immediately; (2) `ApiError` silently dropped the `violations` array from cap-violation error responses, breaking the safety-critical "why was this rejected" UI; (3) `InfusionsService.listOrdersForPatient` was missing the `medicine` relation include (only `getOrder` had it), crashing the doctor dashboard the moment a patient with any order was viewed — pattern to remember: every new list/read endpoint needs the same relation-completeness as its detail counterpart; (4/5/6) three modals (`ClaimActionModal`, `RevokeModal`, `DischargeConfirmModal`) missing the shared `.patient-form` wrapper div, breaking layout without throwing any JS error — only caught by looking at a screenshot; (7) `ClaimActionModal`'s remarks textarea was disconnected from React state, silently discarding input. All fixed and reverified live. Known minor polish item, not fixed: Admin's fleet table originally showed raw patient UUIDs instead of names (later fixed during the M7 pass, see below).

**Environment note**: Playwright is installed to `I:\playwright-browsers` (no `chromium-cli` in this environment); verification scripts live in a throwaway `I:\_pw_scratch` npm project (separate from the pnpm workspace to avoid corrupting it) — recreate with `npm init -y && npm install playwright@1.63.0` if it's gone. Docker Desktop, the API server, and Vite do NOT survive a session interruption — always verify `docker ps` / `curl localhost:3000/health` / `curl localhost:5173` before assuming anything is running; Postgres/Redis data itself persists in Docker volumes regardless. TaskStop/killing a background task ID does NOT reliably kill the underlying OS process bound to a port — find and `Stop-Process` the actual PID via `Get-NetTCPConnection` when a restart is needed.

**Two real ecosystem gotchas, worth knowing if touched again**:
1. NestJS 12's companion packages ship pure ESM (no CJS build) — apps/api must stay `"type":"module"` with `nodenext` module resolution, and every relative import needs an explicit `.js` extension (even though the file is `.ts`). `packages/shared-types` needs the same treatment plus an actual `tsc` build step — **must be rebuilt (`pnpm --filter @infusion/shared-types build`) after every schema-file edit** for changes to propagate to apps/api and apps/web; forgetting this causes stale-type errors that look like something else.
2. **Jest's e2e suite is broken** (`apps/api/test/app.e2e-spec.ts`, header comment has detail): Jest's experimental `--experimental-vm-modules` ESM support doesn't cleanly load `@nestjs/throttler@6.6.0` when the full `AppModule` graph is instantiated in-process. Root-caused to a package/Jest-resolver interaction, not application code. Plain (non-e2e) Jest unit tests work fine.

**M6 status: security hardening + production Docker deployment + load/soak test complete, all verified live — this closed out the original M1–M6 plan.** Security hardening: gated Swagger/`/api/docs` behind non-production; added `@Throttle` to every credential/token-issuing endpoint; fixed `InsuranceController.listClaims`'s unvalidated `status` query param (was blind-cast, risking a 500 — now validated with a clean 400); raised the password minimum from 8 to 12 chars (NIST SP 800-63B favors length over composition rules). Full findings + reasoning in `I:\infusion_platform\SECURITY.md`.

`pnpm audit` findings all investigated for actual reachability (see SECURITY.md's table), including confirming inside the *built production Docker image* (not just the dependency graph on disk) whether a flagged dev-tool dependency actually ships — it did (`deepmerge-ts` via `prisma`'s optional peer relationship), but the app's own code never imports the vulnerable path, so it's dead code on disk, not on the request path. Worth remembering: "is this a devDependency" is not the same question as "does this ship in the image."

**A real, production-only bug caught by actually deploying, not by review**: the refresh-token cookie's `Path` is set by the API's own response header, but the API's internal route is `/auth/*` while the browser's public path through Caddy is `/api/auth/*` — so the cookie was never sent back in production, silently breaking refresh/logout, invisible in dev (no proxy prefix). Fixed via a configurable `REFRESH_COOKIE_PATH` env var (`/auth` dev, `/api/auth` prod), confirmed with a real curl cookie-jar round-trip against the actual built-and-running prod Docker stack. **Pattern to remember**: any cookie-Path/redirect/CORS logic needs to be re-verified against the actual reverse-proxy topology, since dev (direct-to-API) and prod (behind a path-stripping proxy) are not equivalent even when application code is unchanged.

**Production deployment artifacts, all built and live-verified**: `apps/api/Dockerfile` (multi-stage, `pnpm deploy --prod`; migrations run only via an explicit `docker compose run --rm migrate` one-off, never on container boot); `apps/web/Dockerfile` (Vite build served by Caddy, terminates TLS, reverse-proxies `/api/*`); `infra/docker/docker-compose.prod.yml` + `.env.prod.example` + `Caddyfile`. Verified end-to-end under an isolated `infusion-prodtest` compose project (separate from the running dev stack).

**Load/soak test**: two consecutive 2-minute soaks (8 virtual users, realistic polling, not synthetic max-throughput) against the dev server — zero non-2xx across 961 total requests, no leak indicated (RSS growth on the second run was ~20x smaller than the first, consistent with warmup not a leak). Full methodology in `docs/deployment.md`.

**apps/web has zero unit test files** — verification relied entirely on live Playwright browser automation instead (which caught 7 real bugs across the session). Flag to the user if real unit test coverage is wanted; out of scope for M6.

**This closed every phase (M1–M6) of the original plan.** What follows is the M7 extension, planned and approved 2026-09-18–19, now in implementation.

---

## M7 — bedside creation, superuser role, immutable audit trail (in progress)

**Full design lives in `docs/plan.md`** (§ "M7 — Bedside (machine-originated) patient/order creation" and § "Super-user role + live machine-mirror view") — read it in full before continuing this work, this section is a compressed status index only.

**Core new architecture, confirmed directly by the user, extending "server proposes, machine decides":**
- Patients/orders can now be created **two ways**: staff-authored via the dashboard (existing, syncs *down* as a convenience) OR bedside-authored directly at the machine (new — syncs *up* and becomes the real record). "Machine side is always correct. Server is only for showing what is going on in the machine" — machine-originated data is never gated/rejected server-side, only recorded and flagged for dashboard visibility.
- Bedside "select existing patient" is scoped to that machine's own assignment history, not the hospital-wide roster (PHI exposure). Bedside-created patients/orders are attributed to the **machine's own credential**, not a per-staff login. Duplicate patients get a manual reception review queue, never auto-merge, never blocking the machine.
- Machine tagging is now **admin-only** (reverses the original M2 decision that both doctor and reception could tag).
- **One deliberate, narrow exception to "machine never controlled by the server"**: a new `superuser` role can send real pause/resume/stop/flow-rate-adjust commands the machine is expected to act on. Online-only (refused if not WS-connected, never queued for later), password re-confirmation before send, flow-rate changes hard-checked against dosage caps (server-initiated, unlike machine-authored actions which are flag-only), permanent undeletable `MachineCommand` audit row per attempt.
- **`superuser` role, separate from `admin`** (not an extension of it) — one `RolesGuard` bypass, reuses every existing role dashboard as-is behind a new tabbed shell. Attribution already worked correctly without new code — every existing service already logs the real authenticated user's own id/loginId, never a role label.
- **Live machine-mirror view**: a faithful visual replica of the machine's actual running screen on the web, read directly from the real Android layout (`activity_infusion_monitor.xml`). Exposed a real schema gap: the real screen has independent "Working Mode" and "Working Status" free-text values; `InfusionLiveStatus.pumpState`'s 3-value enum was too narrow — added `workingMode`/`workingStatusRaw`/`pauseTimeSec` fields.
- **Immutable audit trail, confirmed as a hard requirement** ("admin can access data but he can't modify the log"): added a Postgres-level `REVOKE`-equivalent (implemented as `BEFORE UPDATE/DELETE` triggers, since the app's DB role owns its own tables so a literal `REVOKE` has no effect) on all log tables including the new `MachineCommand` — verified live via direct `psql` UPDATE/DELETE attempts, correctly rejected.

**Pre-existing UI/logic gaps found and fixed before M7 landed on top of them** (all live-verified):
1. The infusion-step lifecycle could not complete through the UI at all (stuck permanently at `PENDING_PHARMACY_VERIFICATION`) — wired up `useVerifyStep`/reject/cancel/override into `InfusionStepsPanel`, added the pharmacy verification-queue tab.
2. Machine tagging had no UI anywhere — added Assign/Unassign to Admin's `FleetPanel`.
3. `PatientsService.discharge()` never closed out the patient's machine assignment — fixed in a shared `dischargeCore()` used by both staff- and machine-driven discharge.
4. Production routing-prefix gap (only `/api/*` routed to the API container behind Caddy; machine's own routes are unprefixed) — documented for both `docs/sync-contract.md` and the Android networking spec.

**M7 backend build completed and live-verified this session**: module split (new `SyncOutboxModule` breaking a DI cycle), full Prisma schema migration (superuser role, nullable-for-bedside patient fields, `InfusionTelemetryLog`, `ReconciliationItem`, `MachineCommand`, temp-doctor fields on `DoctorProfile`), immutable-audit-trail triggers, `SyncService.push()` rewritten with per-report transactional isolation dispatching to `registerFromMachine`/`createOrderFromMachine`/`recordMachineReport`/live-status upsert/`createTemporaryFromMachine`, `ReconciliationService` (patient-dedup + medicine-name matching, human-reviewed only), superuser RBAC bypass, temporary-doctor lifecycle (create via machine push → badge in admin UI → promote to a real login account).

**Frontend built and browser-verified this session**: pharmacy verification queue tab, reject/cancel/override modals wired into `InfusionStepsPanel`, Admin `FleetPanel` Assign/Unassign Patient UI, `SuperUserDashboard` (tabbed shell reusing all 5 existing dashboards, deliberately with no outer `AppShell` since each child dashboard already renders its own), reconciliation review-queue modal on Reception's dashboard, temporary-doctor badge + promote action in `ManageDoctorsPanel`.

**A real application bug found via live testing during this pass**: `SyncService`'s `infusion_step` dispatch originally tried to set a nonexistent `dispensedVolumeMl` field directly on `InfusionStep` — Prisma rejected it. Root-caused: dispensed volume belongs on `InfusionLiveStatus`/`InfusionTelemetryLog`, not the step itself. Fixed to compute `extraData` from the fields that actually exist (`startedAt`/`completedAt`), matching what the staff-driven methods already set. The new per-report error isolation in `push()` worked correctly here — this surfaced as a clean per-report error, not an aborted batch.

**A real, somewhat surprising pre-existing discovery, not introduced this session**: `RolesGuard` already had `user.role === 'admin' || ...` as an unconditional bypass *before any of this session's changes* — meaning admin has always had backend access to every role's endpoints, contradicting the plan's stated "strict separation of duties" in practice (though with no frontend UI surface to exercise it). Flagged to the user directly.

**M7 website work is now fully complete (2026-09-19), all live-verified.** What was "still outstanding" above is now done:
- RBAC narrowing (§7): patient machine-tag/untag routes are now `@Roles('admin')` only (were `admin`/`doctor`/`reception`).
- Real-time live-status push, both directions: `InfusionsService`'s staff-driven writes (start/pause/resume/complete) now broadcast over WS too (previously only the machine-push path did); `apps/web/src/lib/realtime.ts` (new) connects on login via `AuthContext`, writes `infusion_live_status.updated` straight into the TanStack Query cache — confirmed live, no reload needed.
- **Real bug found and fixed along the way**: `Machine.status` (the fleet "connected" count) defaulted to `offline` and was never written anywhere in the API — the count had silently always undercounted since the feature was built. Fixed in `SyncGateway.handleConnection`/`handleDisconnect`, broadcasting `machine.status_changed`, which the frontend now listens for and invalidates immediately (not left to a 15s poll — this same status gates the remote-command safety check below, so staleness there is a real safety concern, not a display nit).
- Super-user remote commands built end-to-end: `POST/GET /machines/:id/commands`, password re-confirmation, online-only gate, hard `CAP_VIOLATION` gate on flow-rate changes, permanent `MachineCommand` audit row, and a `machine.command_result` WS ack path. **Building the ack path surfaced that this was the app's first-ever `@SubscribeMessage` WS handler, and the three globally-registered HTTP guards (JwtAuthGuard/RolesGuard/ThrottlerGuard) both crash against a WS execution context** (one reads `request.headers`, one calls `res.header(...)`, neither exists in a WS message context) — fixed with `@Public()` + `@SkipThrottle()` on that handler, the same pattern the machine-facing HTTP routes already use with their own separate auth guard. Any future WS message handler in this app needs the same two decorators.
- `MachineMirrorView.tsx` built — faithful replica of the real Android screen (flow-rate hero, mode card, status card with the 5-stat row), reachable from Admin's `FleetPanel` "View Live" action (INFUSION_PUMP only) and the superuser shell. Deliberately re-derives live machine status from the shared fleet-status query cache rather than a static snapshot prop, after catching a real staleness bug where the Pause button's enabled state could lag a real connectivity change by up to 15 seconds.
- `docs/sync-contract.md` fully rewritten to document the whole M7 contract, explicitly marked as not yet targeted by the currently-shipping Android build.

Focus now moves to the Android app's networking-layer rewrite (separate repo/session, `infusionapp2-ca` — full old→new mapping table already written in `docs/plan.md`).

**Known, deliberately-not-fixed minor gaps**: `DoctorsService.getHistory()` would match unrelated `actorUserId: null` audit rows for a temporary doctor (`userId === null`) instead of returning nothing sensible — flagged, not fixed, out of scope for the current pass. `ChangePasswordPage.tsx` has no CSS styling at all (pre-existing, predates this session, purely cosmetic).

**Local dev networking, verified on this machine**: Android emulator reaches the host via `10.0.2.2`; a physical device on the same Wi-Fi needs the host's real LAN IP (re-check if it changes — was `192.168.29.173` at time of writing). Server listens on all interfaces already; Android manifest already has `usesCleartextTraffic="true"`. Windows Firewall has both Allow and Block rules for Node.js present (ambiguous which wins) — flagged as the likely culprit if physical-device testing can't reach the server, not yet resolved.
</content>

---

## Vigil ECMO monitoring (2026-10-21, from `Portal.zip`)

**What it is**: the user handed over `Portal.zip`, holding a 36-month "Vigil critical care platform" plan plus a Python stdlib reference prototype (rules DSL → signal quality → alarms → central station, with a TEST/LIVE switch). It was integrated as the ECMO machine type's real clinical layer, replacing the old "framework now, specifics later" placeholder. Full guide: `docs/vigil/README.md`. Decisions: `docs/vigil/adr/ADR-006`.

**Shape**:
- `packages/vigil`: TS port of the engine.
- `apps/api/src/vigil`: `VigilModule`, polled by the web.
- `apps/web/src/features/vigil`: `/central-station`.
- Shared-types `vigil.schema.ts`: the contract.
- `reference/vigil-python`: the read-only spec.
- Docs: `docs/vigil/{implementation-plan.md, adr/, proto/}`.

**Parity is exact and tested**: the TS simulator ports CPython's MT19937 + `gauss()` and Python-style rounding (`pyFixed`), so all 5 scenarios reproduce the reference's frame-stream SHA-256 and alarm transitions to the second. Golden files: `packages/vigil/test/golden`, regenerated by `py packages/vigil/scripts/export_golden.py`. Python is available on this machine as `py` (3.12); `python` is only the Store alias.

**Fleet ↔ Vigil mapping**:

| Vigil | Fleet |
|---|---|
| device | ECMO `machineCode` |
| encounter | patient id |
| association | active `PatientMachineAssignment` |

- Confirmation is the new `vigilConfirmedAt/ById` columns. A clinician confirms on the central station; rules don't run before that.
- LIVE ingest is `POST /vigil/ingest`: HL7 PCD-01, machine-credential auth. Samples are always attributed to the authenticated machine.
- Audit: `vigil_audit_ledger`, hash-chained per mode, behind the same `prevent_log_mutation` trigger. Migration `*_vigil_ecmo_monitoring`.
- Invalid Vigil config disables only Vigil, not the API.

**Verified live this session**:
- RBAC (401/403), TEST runs, and acknowledgement attributed to the login.
- In the browser: level 3 after 5.5 s of server loss, and the DOM-only crash fallback.
- LIVE end to end:
  - unconfirmed machine raises no alarms
  - confirm → HIGH flow-loss alarm
  - silence → comm-lost alarm
  - untag → alarms resolved with a reason
- Both audit chains verify.

**Pre-existing bug found and fixed**: the web `LiveStatus` interface lacked M7's `workingMode`/`workingStatusRaw`/`pauseTimeSec`. `MachineMirrorView` used them, so `tsc -b`, and therefore `vite build` and the web image, had been failing. It went unnoticed because the Vite dev server doesn't typecheck.

**Dev-DB fixtures created for testing**, all clearly named; delete or deactivate if unwanted:
- doctor user `vigil.devtest`
- ECMO machine `VIGIL-DEV-ECMO`, now unassigned, with an active credential
- patient "Vigil Dev Test Patient" (`VIGIL-DEV-001`)

The other seeded users' passwords (doctor/admin/superuser) had been changed in earlier sessions and are unknown to Claude; only reception still has its seed password.

**Hosting**: the user bought **0dh.in** for this site; it is set as `DOMAIN` in `infra/docker/.env.prod.example`. The user is weighing free hosting (Oracle free VM + Cloudflare Tunnel). Any such public or free deployment must stay in Vigil TEST mode (no BAA), and the prod compose pins `VIGIL_LIVE_MODE` to false by default.
