# Vigil: ECMO monitoring in the Infusion Platform

Vigil watches ECMO machines and raises alarms. It works in four stages:

1. Device data is normalized to canonical units.
2. Each sample gets a signal-quality score.
3. Rules written in a small typed language evaluate the data.
4. Alarms appear on a web **central station**.

Vigil is a **secondary alarm display**: the bedside devices' own alarms stay primary. Rule thresholds are
placeholders that have not been clinically signed off.

> This is not a medical device. Run LIVE mode only for supervised evaluation, and only on infrastructure covered by
> the required data-protection agreements.

## Documents

| | |
|---|---|
| [implementation-plan.md](implementation-plan.md) | The full 36-month Vigil plan (scope, stack, contracts, phases) |
| [adr/ADR-004](adr/ADR-004-python-reference-prototype.md) | The Python prototype is the executable specification |
| [adr/ADR-005](adr/ADR-005-test-live-mode-switch.md) | The single TEST / LIVE mode switch |
| [adr/ADR-006](adr/ADR-006-integration-into-infusion-platform.md) | How Vigil is integrated here, and why |
| [proto/vigil/v1](proto/vigil/v1/) | Contracts: envelope, observation, association, alert, therapy, audit |
| [reference/vigil-python](../../reference/vigil-python/) | The Python reference prototype (read-only spec) |

## What is where

| Plan item | Here |
|---|---|
| 1.8 rule engine | [packages/vigil/src/rules](../../packages/vigil/src/rules/): parser, unit type checker, Class C check, required tests, runtime |
| 1.9 safety floor, §5.5 example rule | [packages/vigil/rules/*.vrl](../../packages/vigil/rules/) |
| 1.2 / 1.3 drivers | [packages/vigil/src/drivers.ts](../../packages/vigil/src/drivers.ts): driver host with fault isolation and restart; HL7 PCD-01 parser and ACK; simulated ECMO console |
| 1.4 normalizer, 1.6 signal quality, 1.7 associations | [packages/vigil/src/pipeline.ts](../../packages/vigil/src/pipeline.ts) |
| Alert lifecycle | [packages/vigil/src/alerts.ts](../../packages/vigil/src/alerts.ts), [engine.ts](../../packages/vigil/src/engine.ts) |
| Audit ledger | [packages/vigil/src/audit.ts](../../packages/vigil/src/audit.ts) and the `vigil_audit_ledger` table |
| 0.5 simulators | [packages/vigil/src/sim](../../packages/vigil/src/sim/), [packages/vigil/scenarios](../../packages/vigil/scenarios/) |
| §7 replay | [packages/vigil/src/replay.test.ts](../../packages/vigil/src/replay.test.ts): golden parity with the Python reference, plus every declared rule test |
| API | [apps/api/src/vigil](../../apps/api/src/vigil/) (`VigilModule`) |
| 2.8 central station | [apps/web/src/features/vigil](../../apps/web/src/features/vigil/), route `/central-station` |
| API ↔ web contract | [packages/shared-types/src/vigil.schema.ts](../../packages/shared-types/src/vigil.schema.ts) |

## Operating mode

`VIGIL_LIVE_MODE` is read once at API start-up. Switching modes needs a restart, by design.

| | `false` (default): **TEST** | `true`: **LIVE** |
|---|---|---|
| Data | Simulated patient scenarios (`packages/vigil/scenarios`) | HL7 PCD-01 from registered ECMO machines, sent to `POST /vigil/ingest` |
| Clock | Simulated, 1–600× real time | Wall clock |
| Machine ingest | Refused (403) | Accepted |
| Scenario controls | Available | Refused (403) |
| Identities | `VIGIL_TEST_*`, must start with `sim` | `VIGIL_LIVE_TENANT_ID` / `VIGIL_LIVE_UNIT_ID` required, must not start with `sim` |
| Alerts | Tagged TEST | Untagged |
| Audit chain | `mode = 'test'` | `mode = 'live'` |

If the configuration is invalid, Vigil stays disabled and says why on the central station. The rest of the
platform keeps running. All variables are listed in [apps/api/.env.example](../../apps/api/.env.example).

## Central station

Open `/central-station`, or use the **ECMO central station** link in the header. The page is for `doctor`,
`admin` and `superuser`. It shows:

- **Operating-level banner (0–3).** It is part of the page and cannot be hidden.
  - 0: full operation
  - 1: degraded (silent or unconfirmed machines, driver faults)
  - 2: safety floor only
  - 3: this screen has lost the server for more than 5 s, or the session expired
- **Active alerts.** Each shows the IEC 60601-1-8 priority marker, the rule's explanation and an **Acknowledge**
  button. The acknowledgement is recorded under your login.
- **One card per machine.** Each card shows:
  - live values with their age
  - trend charts with a hover crosshair and a table view
  - low-quality samples as hollow rings (rules ignore them)
  - alert periods shaded on the charts
  - lab history
- **Staleness.** A machine silent for more than 5 s greys out and says "No live data".
- **Confirm association** (on unconfirmed machines). Therapy rules do not run on a machine's data until a clinician
  confirms, at the bedside, that the console really is on the tagged patient.
- **TEST mode bar.** Scenario picker, speed, restart and progress with annotated events.

**Alarm isolation.** The page polls into a store that lives outside React. If any part of the page crashes, a
plain-DOM fallback lists the active alarms and keeps updating them.

## API

| Route | Who | |
|---|---|---|
| `GET /vigil/state?window=900\|1800\|3600\|21600` | doctor | Snapshot for the central station |
| `POST /vigil/alerts/:id/ack` | doctor | Acknowledge (short or full alert id) |
| `POST /vigil/associations/:id/confirm` | doctor | Confirm an association. LIVE: `:id` is the PatientMachineAssignment id |
| `POST /vigil/test/run` `{scenario?, speed?}` | doctor | TEST only: start or restart a scenario |
| `POST /vigil/test/speed` `{speed}` | doctor | TEST only |
| `GET /vigil/audit/verify` | admin | Verify the current mode's hash chain |
| `POST /vigil/ingest` | ECMO machine | LIVE only. See [sync-contract.md](../sync-contract.md#ecmo-monitoring-data-vigil) |

`admin` and `superuser` pass every role check (existing `RolesGuard` behaviour).

## Connecting a real ECMO machine (LIVE)

1. Configure the API and restart it:
   - `VIGIL_LIVE_MODE=true`
   - `VIGIL_LIVE_TENANT_ID` and `VIGIL_LIVE_UNIT_ID`
   - `VIGIL_HL7_CODES`: map the console's OBX-3 codes to Vigil signals, e.g.
     `{"MDC:QB":"ECMO_BLOOD_FLOW","MDC:DPOXY":"ECMO_OXY_DELTA_P","MDC:SWEEP":"ECMO_SWEEP_FLOW"}`
2. Admin, in the Fleet panel:
   - Register the machine with type **ECMO**.
   - Issue its credential.
   - Assign it to the patient.
3. The machine (or its gateway) POSTs ORU^R01 messages to `/vigil/ingest`, sending its id and token in the
   `x-machine-id` and `x-machine-token` headers. Each frame gets an HL7 ACK back.
4. A clinician checks the console at the bedside, then presses **Confirm association** on the central station.
   Rules start running.
5. When the machine is unassigned, its rules stop and its alarms resolve, with the reason recorded.

Signals the rules know today ([packages/vigil/src/codes.ts](../../packages/vigil/src/codes.ts)):

- `ECMO_BLOOD_FLOW` (L/min)
- `ECMO_OXY_DELTA_P` (mmHg; kPa is converted)
- `ECMO_SWEEP_FLOW` (L/min, setting)
- `BG_POST_OXY_PO2` (mmHg, lab)

Unmapped codes are kept and flagged, never dropped. They never reach the rules.

## Changing rules

Rules live in [packages/vigil/rules](../../packages/vigil/rules/). The compiler rejects:

- unit mismatches (a kPa limit on an mmHg signal)
- missing units
- non-Class C functions in `safety_floor true` rules
- rules without at least one `expect fire` and one `expect no_fire` test

Then run:

```sh
pnpm --filter @infusion/vigil test            # unit + replay + every declared rule test
py packages/vigil/scripts/export_golden.py    # only after changing the Python reference itself
```

The replay suite compares every scenario with the Python reference's golden output. Any change in alarm timing must
be explained, then re-exported from the reference.

## Not done yet

| Plan area | Status |
|---|---|
| Edge placement (1.1, 1.10–1.12) | The safety floor runs on the server here. Running it on the machine/edge, with local alarms and nurse call, belongs to the separate machine effort; the `.vrl` files are its specification |
| Streaming (§3.1) | 1 s JSON polling instead of WebSocket + protobuf; no WebGL waveforms |
| State persistence | Rule state and active alerts live in memory: a restart re-warms the rules. Single API instance only |
| Rule governance (2.7) | No rule editor, two-person approval or replay impact report; rules change through code review |
| IABP, more signals, models (Phase 3) | ECMO only, three rules |
| Integrations (2.6) | No EHR write-back, ADT feed or nurse-call adapters |
