# Machine Sync Contract

This is the protocol a machine (the future Android infusion-pump controller, and eventually ECMO/EBOO integrations) must implement to talk to the Infusion Platform server. It is generated/maintained alongside `packages/shared-types/src/sync.schema.ts` and `machine.schema.ts`, which are the single source of truth for every shape referenced here — if this document and those files ever disagree, the schema files win and this doc needs updating.

## Bidirectional vs. unidirectional machine types

Not every machine type talks to the server the same way — see `MACHINE_TYPE_DIRECTIONALITY` in `machine.schema.ts`:

- **INFUSION_PUMP — bidirectional.** The full "server proposes, machine decides" model below applies: the server queues proposals, the machine pulls and accepts/rejects them, and reports its own local changes back.
- **ECMO / EBOO — unidirectional.** These devices are operated directly at the bedside, not remotely commanded. They only ever **push** telemetry/reports to the server via the same `POST /sync/push` shape (with no `proposalId`, since nothing was proposed). The server never queues anything in `sync_outbox` for them, and they never call `GET/POST /sync/pull`. A patient-machine assignment for one of these types is server-side bookkeeping only (correlating incoming telemetry with a patient) and is treated as immediately accepted — there's no device round-trip to wait for.

The rest of this document describes the bidirectional flow; unidirectional machine types use only the "Push" section below.

## Model: "server proposes, machine decides" (bidirectional types only)

The server never holds a credential that can force a machine into a state it didn't locally accept. It queues changes as **proposals**; the machine's own local logic accepts, rejects, or modifies them. The server never re-derives or overrides a machine's decision — it only records and displays what was reported.

## Connection

- Sync is **machine-initiated**. The machine connects to the server (WebSocket when it has a live connection; falls back to the REST delta-sync endpoints otherwise) — the server never makes an inbound call to a machine.
- Authentication: each machine holds its own credential, provisioned out of band (see Open Question in the plan re: provisioning process). Requests are authenticated by that credential — never a server-held master key. A machine with no valid/active credential is hard-rejected (401), never silently treated as authorized.

## Pull — what the machine asks for

`GET/POST /sync/pull` — see `syncPullRequestSchema` / `syncPullResponseSchema`.

The machine sends `{ machineId, sinceVersion }`; the server returns every `SyncProposal` addressed to that machine with `version > sinceVersion`, plus the `latestVersion` to use as the new watermark. Proposal entity types (`SYNC_ENTITY_TYPES`): `patient`, `infusion_order`, `infusion_step`, `medicine`.

## Push — what the machine reports back

`POST /sync/push` — see `syncPushRequestSchema` / `syncReportSchema`.

The machine sends one or more `SyncReport` rows: for each proposal it received, whether it was `accepted`, `rejected` (with a `reason`), or `modified`; plus any locally-originated changes (e.g. a completed infusion step) that weren't tied to a prior proposal. Every report is recorded in `sync_inbox_log` server-side and reflected live on the dashboard — a rejection is never silently retried as if it succeeded.

## Realtime events (when connected live)

See `REALTIME_EVENTS` in `sync.schema.ts`: `infusion_step.transitioned`, `infusion_live_status.updated`, `machine.status_changed`, `sync_proposal.delivered`, `sync_report.received`. These are a live-connection convenience on top of the pull/push model above, not a replacement for it — a machine that only ever polls still gets fully caught up via pull/push.

## Open questions (not yet finalized — see the plan's "Deferred/open items")

- Exact credential provisioning process for a new machine.
- Whether this document should also define a literal inbound-webhook-to-device mode, if that turns out to be the actual intent behind the original "webhook" requirement rather than the machine-initiated model implemented here.
