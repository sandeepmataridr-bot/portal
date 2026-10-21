# Machine Sync Contract

This is the protocol a machine (the Android infusion-pump controller, and eventually ECMO/EBOO integrations) must implement to talk to the Infusion Platform server. It is generated/maintained alongside `packages/shared-types/src/sync.schema.ts`, `machine.schema.ts`, and `infusion.schema.ts`, which are the single source of truth for every shape referenced here — if this document and those files ever disagree, the schema files win and this doc needs updating.

**Status**: the M1–M6 surface described in "Pull," "Push," and "Connection" below is implemented and in production use. The "Bedside-originated creates," "Live telemetry," and "Super-user remote commands" sections describe the M7 extension, also implemented server-side — the currently-shipping Android build (`InfusionApp2`) targets only the M1–M6 surface (pull-and-report on staff-authored proposals); the M7 sections are the spec for that app's next networking-layer pass, not yet consumed by it.

## Bidirectional vs. unidirectional machine types

Not every machine type talks to the server the same way — see `MACHINE_TYPE_DIRECTIONALITY` in `machine.schema.ts`:

- **INFUSION_PUMP — bidirectional.** The full "server proposes, machine decides" model below applies: the server queues proposals, the machine pulls and accepts/rejects them, and reports its own local changes back. It is also the only machine type eligible for the M7 super-user remote-command channel (see below).
- **ECMO / EBOO — unidirectional.** These devices are operated directly at the bedside, not remotely commanded. They only ever **push** telemetry/reports to the server via the same `POST /sync/push` shape (with no `proposalId`, since nothing was proposed). The server never queues anything in `sync_outbox` for them, never sends them a `machine.command`, and they never call `POST /sync/pull`. A patient-machine assignment for one of these types is server-side bookkeeping only (correlating incoming telemetry with a patient) and is treated as immediately accepted — there's no device round-trip to wait for. ECMO clinical monitoring data (flows, pressures, blood gases) goes to Vigil's own `POST /vigil/ingest` instead — see [ECMO monitoring data (Vigil)](#ecmo-monitoring-data-vigil).

The rest of this document describes the bidirectional flow; unidirectional machine types use only the "Push" and "Live telemetry" sections below.

## Model: "server proposes, machine decides" (bidirectional types only)

The server never holds a credential that can force a machine into a state it didn't locally accept. It queues staff-authored changes as **proposals**; the machine's own local logic accepts, rejects, or modifies them. The server never re-derives or overrides a machine's decision — it only records and displays what was reported.

**M7 extends this with a second, upward creation path** — see "Bedside-originated creates" below. The core principle those additions are built on, quoted directly because it is the load-bearing constraint for everything in that section: **"machine side is always correct. server is only for showing what is going on in the machine."** Nothing the machine reports as `outcome: 'reported'` is ever gated, rejected, or overridden server-side — cap/workflow checks on that path are recorded for dashboard visibility only, never enforced. That is a deliberate, explicit extension of the same principle that already governs proposal responses (a rejection is recorded and shown, never silently overridden) — never confuse the two: a **proposal response** (`accepted`/`rejected`/`modified`) is the machine reacting to something the server sent it; a **report** (`outcome: 'reported'`) is the machine telling the server something new that happened, which the server did not originate and cannot veto.

## Connection

- Sync is **machine-initiated**. The machine connects to the server (WebSocket when it has a live connection; falls back to the REST delta-sync endpoints otherwise) — the server never makes an inbound call to a machine, with the one narrow exception of the super-user remote-command channel described below, which is real-time and online-only rather than a queued proposal.
- Authentication: each machine holds its own credential, issued by an admin via `POST /sync/machines/:id/credentials` (shown once, never retrievable again) — never a server-held master key. A machine with no valid/active credential is hard-rejected (401), never silently treated as authorized.
- REST requests: `X-Machine-ID` / `X-Machine-Token` headers, verified by `MachineAuthGuard`.
- WebSocket: connect to the `/realtime` namespace with query params `machineId` and `token` (camelCase — not `machine_id`/`token` snake_case). An invalid credential gets the socket disconnected immediately, no error event. A successful connection also flips `Machine.status` to `online` server-side and broadcasts `machine.status_changed` to dashboard sockets — this is real connectivity tracking, not a display-only flag, and it's what gates whether a super-user remote command can be sent (see below).

### Connecting through production (routing prefix)

`infra/docker/Caddyfile` only routes `handle_path /api/* { reverse_proxy api:3000 }` to the API container — every other path falls through to the static web app's `index.html`. The NestJS routes themselves carry no prefix (`/sync/pull`, `/sync/push`, `/realtime`, `/health`), so:

- **Direct-to-container** (local dev, LAN testing against the bare API port): use the bare paths — `http://<lan-ip>:3000/sync/pull`, `http://<lan-ip>:3000/health`, WS `ws://<lan-ip>:3000/realtime`.
- **Through the real production deployment** (behind Caddy/TLS): call `https://<domain>/api/sync/pull`, `https://<domain>/api/sync/push`, `https://<domain>/api/health`, and connect the socket to `wss://<domain>/api/realtime` — the same `/api` prefix the browser dashboard already uses. Calling the bare, unprefixed paths against the production domain silently hits the SPA's `index.html` fallback instead of the API (a 200 with HTML, not a clean error) — the same category of bug as the refresh-cookie-path issue fixed in M6, invisible in direct-to-container testing, real in production. A machine's base-URL config must support both shapes; do not hardcode one.

## Pull — what the machine asks for

`POST /sync/pull` — see `syncPullRequestSchema` / `syncPullResponseSchema`.

The machine sends `{ machineId, sinceVersion }`; the server returns:

```jsonc
{
  "proposals": [ /* SyncProposal[], version > sinceVersion, see below */ ],
  "latestVersion": 42,
  // M7 addition: reference data, not proposals — never versioned/delta'd,
  // sent in full on every pull given its small size. Deliberately
  // hospital-wide, not scoped per-machine like patient proposals are (any
  // doctor might need to be attributed on any machine, including from the
  // bedside-created-doctor path below).
  "doctors": [
    { "id": "uuid", "name": "Dr. Jane Doe", "qualification": "MBBS, MD", "specialty": "Cardiology" }
  ]
}
```

Proposal entity types (`SYNC_ENTITY_TYPES`): `patient`, `infusion_order`, `infusion_step`, `medicine`, plus the M7-only report-side types `infusion_live_status` and `doctor` (a proposal is never generated for those two — they only ever appear as `outcome: 'reported'` pushes, never pulled).

**Explicitly out of scope for `pull()`**: a patient's full historical infusion record (past completed orders from earlier admissions). The machine only ever receives current/pending data, never the archive.

## Push — what the machine reports back

`POST /sync/push` — see `syncPushRequestSchema` / `syncReportSchema` / `syncPushResponseSchema`.

The machine sends one or more `SyncReport` rows in a single `{ machineId, reports: [...] }` batch. Each report is processed and recorded **independently** — one malformed or failing report never aborts the others in the same batch. The response reflects this:

```jsonc
{
  "received": 3,
  "results": [
    { "entityType": "infusion_step", "entityId": "uuid", "status": "ok" },
    { "entityType": "patient", "entityId": "uuid", "status": "error", "message": "..." },
    { "entityType": "infusion_live_status", "entityId": "uuid", "status": "ok" }
  ]
}
```

Two distinct kinds of report share the same `syncReportSchema` shape, discriminated by `proposalId` presence + `outcome`:

### 1. Proposal responses (`proposalId` set)

`outcome` is `accepted`, `rejected` (with a `reason`), or `modified` — the machine reacting to something the server proposed. Recorded in `sync_inbox_log` and reflected live on the dashboard; a rejection is never silently retried as if it succeeded.

### 2. Reports (`proposalId` absent, `outcome: 'reported'`) — M7 addition, bedside-originated

Machine-originated: "this simply exists/happened," no prior proposal behind it. **Never gated or rejected** — see the "machine is always correct" principle above. `entityType` determines the payload shape and which service handles it:

**`patient`** — either a new bedside-registered patient, or a discharge report, discriminated by `payload.action`:
```jsonc
// Create (payload.action absent or 'CREATE')
{ "entityType": "patient", "entityId": "<client-minted-uuid>", "outcome": "reported", "occurredAt": "...",
  "payload": { "fullName": "...", "age": 45, "gender": "M", "roomOrBed": "ICU-3" /* mobile/emergencyContact/aadhar/ipNumber all optional here */ } }
// Discharge
{ "entityType": "patient", "entityId": "<existing-patient-id>", "outcome": "reported", "occurredAt": "...",
  "payload": { "action": "DISCHARGE" } }
```
A bedside create sets `needsReceptionCompletion: true` on the record and runs a hospital-wide duplicate search (`ReconciliationService.findPatientDuplicates`) — a match is flagged into the reception review queue, **never blocks the create and never auto-merges**. "Select existing patient" at the machine itself is scoped only to that machine's own assignment history (PHI exposure concern for a shared bedside device), a narrower scope than this server-side dedup search. A discharge always closes out any active `PatientMachineAssignment` for the reporting machine, same as a staff-driven discharge.

**`infusion_order`** — a bedside-authored order + its steps, created and immediately treated as the real record:
```jsonc
{ "entityType": "infusion_order", "entityId": "<client-minted-uuid>", "outcome": "reported", "occurredAt": "...",
  "payload": {
    "patientId": "...",
    "steps": [
      { "id": "<client-minted-uuid>", "stepNumber": 1, "medicineId": "uuid", "plannedVolumeMl": 100, "plannedRateMlPerH": 50, "status": "RUNNING" },
      { "id": "<client-minted-uuid>", "stepNumber": 2, "medicineName": "Ringer Lactate", "concentrationRaw": "500ml", "plannedVolumeMl": 200, "plannedRateMlPerH": 30, "status": "DRAFT" }
    ]
  } }
```
A step may reference a catalog medicine by `medicineId`, or fall back to a raw `medicineName`/`concentrationRaw` when the machine can't resolve one locally — exactly one of the two, per step. Dosage/rate caps are still checked for resolved medicines, but **only to record the result**, never to block (`InfusionStepEvent` gets a recorded-not-enforced cap-check entry); an unresolved medicine name is routed to the reconciliation queue (`kind: medicine_match`) instead. Idempotent on the client-minted `entityId` — a retried push after a dropped connection returns the already-created order rather than erroring or double-creating.

**`infusion_step`** — a status update on a step the server already knows about (bedside-created or originally staff-proposed): `payload.status` may jump directly to any target status (`assertStepTransition`'s normal ordering is **skipped** for machine reports — an offline machine may legitimately report `DRAFT → COMPLETED` in one shot after running the whole thing disconnected).

**`doctor`** — a temporary, bedside-created doctor reference for offline/emergency attribution, not a login-capable account:
```jsonc
{ "entityType": "doctor", "entityId": "<client-minted-uuid>", "outcome": "reported", "occurredAt": "...",
  "payload": { "name": "Dr. Emergency Oncall", "qualification": "MBBS", "specialty": "General" } }
```
Creates a `DoctorProfile` with no linked `User` (`isTemporary: true`), attributed to the reporting machine's credential. An admin can later "promote" it into a real login account (`POST /doctors/:id/promote`) from the dashboard; until then it's purely a reference for patient/order attribution.

**`medicine`** — never machine-originated. The catalog is server/pharmacy-owned; a report of this type is a no-op.

**Client-minted UUIDs (real requirement, not a server detail)**: the machine generates every `Patient`/`InfusionOrder`/`InfusionStep`/`DoctorProfile` id itself at creation time and reuses that same id in every subsequent report referencing that entity. This is what makes retried pushes after a connection drop idempotent instead of duplicate-creating.

## Live telemetry

`entityType: 'infusion_live_status'`, always `outcome: 'reported'`, keyed by `machineId` (`InfusionLiveStatus.machineId` is `@unique` — one current-snapshot row per machine, no history in this table):

```jsonc
{ "entityType": "infusion_live_status", "entityId": "<machineId>", "outcome": "reported", "occurredAt": "...",
  "payload": {
    "patientId": "uuid", "stepId": "uuid | null", "currentMedicineName": "Normal Saline 0.9%",
    "remainingVolumeMl": 250, "dispensedVolumeMl": 150, "flowRateMlPerH": 42, "infusedTimeMin": 90,
    "pumpState": "RUNNING", // RUNNING | PAUSED | STOPPED — coarse, kept for existing consumers
    // Free-text, matching the real machine screen's independent "Working
    // Mode"/"Working Status" values (read directly from
    // InfusionMonitorActivity.kt — not fixed enums, too granular for pumpState above)
    "workingMode": "Continuous", "workingStatusRaw": "Ready", "pauseTimeSec": 0
  } }
```

Every telemetry push does two things server-side: (1) upserts `InfusionLiveStatus` — "what's happening right now," overwritten each time, the source for the dashboard's live mirror view; (2) appends a permanent `InfusionTelemetryLog` row with the same values — the durable, insert-only history (a rate change with no step-status change would otherwise vanish with no trace once the snapshot is overwritten). Both writes also broadcast `infusion_live_status.updated` to every dashboard socket in real time (see "Realtime events" below) — the poll-based `GET /machines/:id/live-status` stays the guaranteed catch-up path, the WS push is a latency optimization on top of it, never the only delivery path.

## Realtime events (when connected live)

`REALTIME_EVENTS` in `sync.schema.ts`, emitted to the `dashboard` room (staff browser sockets) unless noted:

| Event | Payload | Fired when |
|---|---|---|
| `infusion_live_status.updated` | the current `InfusionLiveStatus` row | Any live-status write — staff-driven (`start`/`pause`/`resume`/`complete` step) or machine-pushed telemetry |
| `machine.status_changed` | `{ machineId, status }` | A machine's WS connects or disconnects |
| `sync_proposal.delivered` | the full `SyncProposal` | A new proposal is enqueued while the target machine is already connected — a latency optimization; the machine should still treat `POST /sync/pull` as the authoritative catch-up path, never the only way to learn about a proposal |
| `sync_report.received` | — | Reserved; not yet emitted |
| `machine_command.updated` | `{ machineId, commandId, status }` | A super-user command's status changes (sent → acknowledged/failed) — see below |
| `infusion_step.transitioned` | — | Reserved; not yet emitted |

None of these are a replacement for pull/push — a machine that only ever polls (never holds a live WS connection) still gets fully caught up via `POST /sync/pull`/`POST /sync/push` alone.

## Super-user remote commands (M7 — not a proposal, a real-time command)

This is the **one deliberate, narrow exception** to "the machine always decides" anywhere in this contract — scoped to a single server role (`superuser`) and to `machineType === 'INFUSION_PUMP'` only. Every other role, and every other kind of server→machine data in this document, stays a proposal the machine can freely ignore.

- A superuser sends `POST /machines/:id/commands` from the dashboard (`{ commandType, flowRateMlPerH?, password }` — the password re-confirms the superuser's own login, checked server-side before anything is sent). This is refused outright (409) unless `SyncGateway.isConnected(machineId)` is true **at the moment of sending** — never queued for a machine to pick up later, since a stale pause/stop/rate-change could be dangerous by the time a reconnect happened.
- If accepted, the server emits directly to the machine's own socket room:
  ```jsonc
  // event: "machine.command"
  { "commandId": "uuid", "commandType": "PAUSE" | "RESUME" | "STOP" | "ADJUST_FLOW_RATE", "payload": { "flowRateMlPerH": 42 } /* ADJUST_FLOW_RATE only */ }
  ```
  The machine must: validate the command locally too (never blindly trust the network for a hardware action), act on it via its own hardware control path, and report the outcome back on the **same socket**:
  ```jsonc
  // event: "machine.command_result"
  { "commandId": "uuid", "status": "ACKNOWLEDGED" | "FAILED", "result": { /* optional, freeform */ } }
  ```
  Only trusted from the socket already authenticated as the owning machine (the same credential check from connection time) — never accepted as a bare claim of "I am machine X."
- `ADJUST_FLOW_RATE` is hard-gated against the current step's dosage/rate caps server-side **before it is ever sent** (`BadRequestException` with `code: 'CAP_VIOLATION'` on a violation, same shape as order creation) — unlike the bedside-report cap checks above, which are informational-only. The difference is who's deciding: a remote command is server-**initiated**, so it gets the same hard gate every other server-authored action does; a bedside report is machine-**authored**, so the machine already decided and the server only records it.
- Every attempt — sent, acknowledged, failed, or refused before ever reaching the machine — is a permanent `MachineCommand` row (insert/status-update only, DB-enforced non-deletable) carrying the real issuing user's id, never anonymized.

This channel is unrelated to `sync_outbox`/proposals — it has no version, no accept/reject semantics, and is meaningless to a disconnected machine. A machine not built against this section simply never receives a `machine.command` event (nothing sends one unless a superuser explicitly does, and only for `INFUSION_PUMP` machines).

## ECMO monitoring data (Vigil)

ECMO machines send their clinical data to Vigil, the ECMO monitoring module (design: [docs/vigil/README.md](vigil/README.md)). This is a separate, push-only path. It is not a sync report, and the server never sends anything back except HL7 ACKs.

- **Endpoint:** `POST /vigil/ingest`, or `/api/vigil/ingest` through the production proxy. It uses the same `x-machine-id` / `x-machine-token` credential headers as `/sync/push`. Only machines registered with `machineType: 'ECMO'` may call it (403 otherwise).
- **Mode:** accepted only while the server runs Vigil in LIVE mode (`VIGIL_LIVE_MODE=true`). In TEST mode (the default) the server refuses with 403, so real device data can never mix into a simulated run.
- **Body** (`vigilIngestSchema` in `packages/shared-types/src/vigil.schema.ts`):
  ```jsonc
  { "driver": "hl7_pcd01", "frames": ["MSH|^~\&|...OBX|1|NM|QB^Blood flow^MDC||4.1|L/min^L/min^UCUM|||||F|||20261021120000"] }
  ```
  - `frames` holds 1–200 HL7 v2 ORU^R01 messages (IHE PCD-01), each at most 64 KB.
  - Each numeric OBX becomes one sample:
    - code: OBX-3 `<coding system>:<identifier>`
    - unit: OBX-6, UCUM or an `MDC_DIM_*` code
    - time: OBX-14, falling back to MSH-7
  - The site maps codes to Vigil signals with `VIGIL_HL7_CODES`. Unmapped codes are stored and flagged, never dropped, and never reach the rules.
- **Attribution:** every sample is attributed to the **authenticated machine**, whatever device id OBX-18 or MSH-3 carries. A machine can only ever report for itself.
- **Response:** `{ accepted, rejected, acks }`. `acks` holds one HL7 ACK per frame, in order: `MSA|AA` if accepted, `MSA|AE|<reason>` if malformed. Resend nothing that was `AA`.
- **Rules:** rules run only while the machine has an active patient assignment that a clinician has confirmed on the central station. Data from an unconfirmed or unassigned machine is still recorded and shown, but raises no alarms.
- **Cadence:** about one push per second per machine is expected. The route allows 600 requests per minute per source IP.

## Open questions (not yet finalized — see the plan's "Deferred/open items")

- Whether `entityType: 'patient'` carrying three distinct meanings (assignment-ack, new-patient-create, discharge — disambiguated only by `proposalId`/`outcome`/`payload.action`) should eventually get a distinct type name instead.
- Whether bedside patient-duplicate detection should grow one-click merge tooling, or stay review/documentation-only as it is today.
- Exact shape of the machine's credential/keypair provisioning process beyond the current admin-issues-a-token-via-dashboard flow.
- Whether remote commands should require a second, distinct person's confirmation (true dual-control) rather than the same superuser re-entering their own password.
