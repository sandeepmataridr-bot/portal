# ADR-006: Vigil runs inside the Infusion Platform as a TypeScript port

- **Status:** Proposed
- **Date:** 2026-10-21
- **Deciders:** engineering lead, safety owner (sign-off pending)
- **Supersedes:** nothing. Implements the port that ADR-004 schedules.

## Context

The Vigil plan ([implementation-plan.md](../implementation-plan.md)) and its Python reference prototype
([reference/vigil-python](../../../reference/vigil-python/)) arrived as a separate project.

The Infusion Platform is already a running TypeScript monorepo: NestJS, Prisma/Postgres and React. It has a
fleet registry, and ECMO is already a registered machine type. Until now, ECMO had no clinical fields: it was
push-only telemetry, waiting for "real clinical fields once specified". Vigil supplies those fields: ECMO signals,
rules and alarms.

ADR-004 names the port order:

1. `vigil-rules`
2. Driver SDK
3. Portal (React + TypeScript)

This platform already uses React + TypeScript.

## Decision

1. **Port, don't embed.** The engine is re-implemented in TypeScript as `packages/vigil` (`@infusion/vigil`). The
   port covers:
   - the rule language: lexer, parser, unit type checker, Class C check, required tests, runtime with persistence,
     hysteresis and unknown values
   - normalizer, signal quality and associations
   - alert lifecycle and the hash-chained audit
   - scenario simulators

   No Python runs in the platform.
2. **Parity is tested, not assumed.** The scenario simulator reproduces CPython's `random.Random` bit for bit (MT19937
   plus `gauss()`), and Python-style number formatting. Every bundled scenario must therefore yield the same results
   as the reference:
   - the same frame stream (SHA-256)
   - the same stats
   - the same alarm transitions, at the same second, with the same text

   `packages/vigil/test/golden/*.json` is exported from the reference by `scripts/export_golden.py`. This is
   ADR-004's "identical rule hits", enforced by `src/replay.test.ts` (part of `pnpm test`; the repo has no CI pipeline yet).
3. **The server hosts both rule placements for now.** Both the safety floor (`safety_floor true`) and the core rules
   run in the API's `VigilModule`. In the plan, the safety floor lives on the unit edge, next to the devices. In this
   repository, machines are a separate engineering effort; see the scope boundary in
   [project-memory.md](../../project-memory.md).
   - The `.vrl` rule files are the specification the edge must implement.
   - Alerts keep their placement label (`safety floor` / `core`).
   - Vigil remains a **secondary** alarm display; the bedside devices' own alarms stay primary.
4. **Fleet concepts map onto Vigil contracts.**

   | Vigil | Infusion Platform |
   |---|---|
   | Device | `Machine` with `machineType = 'ECMO'`; device id = `machineCode` |
   | Encounter | `Patient.id` |
   | DeviceAssociation | active `PatientMachineAssignment` (admin-only tagging, unchanged) |
   | Association confirmation (plan 1.7) | new `vigilConfirmedAt/ById` on the assignment, set by a clinician on the central station |
   | Audit ledger | new `vigil_audit_ledger` table: hash-chained, one chain per mode, UPDATE/DELETE blocked by trigger |
   | Device transport (LIVE) | `POST /vigil/ingest`: HL7 PCD-01 ORU^R01, machine-credential auth like `/sync/push` |

   Every sample in an ingest request is attributed to the authenticated machine, whatever device id the HL7 message
   carries. One machine can never feed another machine's patient.
5. **One mode switch, as in ADR-005.** `VIGIL_LIVE_MODE` is read once at start-up.
   - TEST refuses machine ingest.
   - LIVE refuses scenario control and simulators.
   - Identity prefixes are enforced: `sim*` identities in TEST only; LIVE identities must not start with `sim`.
   - Audit chains are kept per mode.
   - On an invalid configuration, **only Vigil** stays down. It reports why on `/vigil/state`, and infusion
     workflows keep running.
6. **Authentication replaces typed names.** The prototype had no login, so it asked for a typed name before
   acknowledging. Here, acknowledgements and confirmations are attributed to the logged-in user's `loginId`.
   RBAC:
   - `doctor`: view, acknowledge, confirm, run TEST scenarios
   - `admin`: verify the audit ledger
   - `admin` and `superuser` pass every route through the existing `RolesGuard` bypass

## Consequences

- **Polling, not streaming.** Transport is 1 s JSON polling of `/vigil/state`, as in the prototype; the plan wants
  WebSocket + protobuf. Polling makes level-3 detection trivial: any failed poll for more than 5 s.
- **Rule state is in memory, in one API instance.** A restart re-warms the rules. Trend rules need up to their
  window, for example 6 h, before they can fire again. Alerts active at shutdown are not restored, though every
  transition is in the ledger. A second API replica would fail on the ledger's `(mode, seq)` key rather than fork
  it. Persisted rule state is follow-up work.
- **Thresholds are placeholders.** Rule thresholds are not clinically signed off, and the rule-governance UI (plan
  2.7) does not exist. Rules change by editing `packages/vigil/rules/*.vrl` under code review, with the replay suite
  passing.
- **No LIVE mode with real patient data on free or uncovered hosting.** HIPAA (or local equivalent) needs a signed
  BAA/DPA. Public demos run TEST mode, which `infra/docker/.env.prod.example` sets by default.
