# Vigil: first vertical slice

Implements the plan's "first 30 days" demo (`../vigil-implementation-plan.md` §13): a simulated ECMO
patient goes through driver → normalizer → signal quality → rules → alarm, plus a web central station.
Everything runs on the Python 3.11+ standard library (developed on 3.14); nothing to install.

> This is a reference prototype, not a medical device. Rule thresholds are placeholders that have not been
> clinically signed off.

## Operating mode: one switch

`live_mode` in [vigil.toml](vigil.toml) (or the env var `VIGIL_LIVE_MODE=true|false`, which wins):

| | `live_mode = false`: **TEST** | `live_mode = true`: **LIVE** |
|---|---|---|
| Data | Device simulators driven by a patient scenario | Real devices only: HL7 PCD-01 over MLLP |
| Clock | Simulated, runs faster than real time | Wall clock |
| Simulated drivers | Allowed | Refused (`ModeViolation`) |
| Identities | tenant/unit must start with `sim` | tenant/unit required, must not start with `sim` |
| Alarms | Console and web, tagged TEST; nurse call never contacted | Console, web and nurse-call adapter |
| Audit ledger | `var/test/audit.jsonl` | `var/live/audit.jsonl` |
| Website | Scenario picker, speed, restart | Device data only |

Every envelope and alert carries `test_mode`, and the node rejects traffic from the other mode.
LIVE mode refuses to start until the `[live]` section is complete.

## Run it

```powershell
python vigilctl.py web                    # central station at http://127.0.0.1:8080/
python vigilctl.py run                    # console only: plays [test] scenario
python vigilctl.py run --scenario ecmo/flow_loss_01
python vigilctl.py test-rules             # tests declared inside the rules
python vigilctl.py mode | scenarios | check-rules | audit-verify
python -m unittest discover -s test -t .  # 53 tests
```

## Central station (website)

The [apps/central_station/](apps/central_station/) folder has a stdlib HTTP server plus static HTML/CSS/JS
with no CDN, so it works on an offline hospital network. It shows:

- **Operating-level banner (0–3).** It is part of the page shell and cannot be hidden.
  - 0: full operation
  - 1: degraded (silent or unconfirmed machines, driver faults)
  - 2: edge safety floor only
  - 3: this screen has lost the edge node
- **Active alerts.** Each shows the IEC 60601-1-8 marker and label (`!!!` HIGH, `!!` MEDIUM, `!` LOW), the
  rule's explanation, and an acknowledge button.
- **One card per machine.** Cards show live values with their age, trend charts with a hover crosshair and a
  table view, and lab history.
  - Samples with low signal quality appear as hollow rings and are excluded by the rules.
  - Alert periods are shaded on the charts.
- **Staleness.** A machine silent for more than 5 s greys out and says "No live data". If the browser loses the
  server for more than 5 s, the whole page dims and the banner switches to level 3.
- **Alarm isolation.** Alarms render first and on their own. If any other part of the page crashes, a
  full-screen fallback still lists the active alarms.

The page follows the light/dark system theme and has a toggle. The server binds to 127.0.0.1 and has no login
yet, so in LIVE mode do not expose it beyond the edge host.

## What is where

| Plan item | Here |
|---|---|
| §5 contracts | [proto/vigil/v1/](proto/vigil/v1/) (source of truth) and the mirror in [shared/vigil_contracts](shared/vigil_contracts/__init__.py) |
| 1.2 driver SDK | [edge/driver_sdk](edge/driver_sdk/__init__.py): ABI, mode guard, fault isolation and restart |
| 1.3 drivers | [edge/drivers](edge/drivers/): HL7 PCD-01 with MLLP listener (both modes), simulated ECMO console (TEST only) |
| 1.4 normalizer | [edge/normalizer](edge/normalizer/__init__.py): converts kPa to mmHg and keeps the raw value; unmapped data is flagged, never dropped |
| 1.6 SQI | [edge/sqi](edge/sqi/__init__.py): range, flush/step artifact, flatline |
| 1.7 association | [edge/association](edge/association/__init__.py): therapy rules run only on confirmed associations |
| 1.8 rules engine | [shared/vigil_rules](shared/vigil_rules/): parser, unit type checker, Class C check, required tests, runtime with persistence, hysteresis and unknown-data handling |
| 1.9 safety floor | [edge/safety_engine/rules](edge/safety_engine/rules/ecmo_safety_floor.vrl): flow loss, console communication lost |
| §5.5 example rule | [core/cds_runtime/rules](core/cds_runtime/rules/ecmo_oxygenator.vrl): verbatim from the plan |
| 1.10 local alarm | [edge/local_alarm](edge/local_alarm/__init__.py): alert lifecycle, console display, nurse-call adapter interface |
| 2.8 central station | [apps/central_station](apps/central_station/) |
| Audit ledger | [core/audit_ledger](core/audit_ledger/__init__.py): hash-chained JSON lines, tamper detection |
| 0.5 simulators | [simulators](simulators/): scenario format, device simulators, five ECMO scenarios |
| §7 replay | [test/replay](test/replay/test_rule_scenarios.py): every declared rule test, plus proof that the flush test needs SQI gating |

Package names use `_` where the plan uses `-` (Python imports).

## Not done yet (by plan epic)

| Area | Status |
|---|---|
| Production stack | Rust engine/drivers, Go BFF, and the React/TypeScript portal from §3.1 are not started; only Python is installed on this machine (see [ADR-004](docs/adr/ADR-004-python-reference-prototype.md)) |
| Web transport and login | Polling JSON once a second instead of WebSocket and protobuf; no Keycloak/OIDC login (2.10) |
| Edge platform | Edge OS image (1.1); sandboxed driver processes (1.2); time sync (1.5); NATS replication (1.11); forwarder (1.12) |
| Devices and core | SDC consumer and real vendor ECMO/IABP drivers (these need vendor agreements, 0.8); IABP rules; Kafka, stores and the core cluster (2.1–2.2) |
| Integrations | Real nurse-call vendor adapters; EHR write-back |
| Engineering process | CI, SBOM, signing (0.3); traceability and QMS documents |
