# Vigil Critical Care Platform: Implementation Plan

Companion to the design doc `vigil-platform-design.html` (same folder). The design says *what* Vigil is; this file says *how to build it*, in what order, and how to know each piece is done.

- **Audience:** engineering lead, architects, QA/RA lead, clinical lead.
- **Horizon:** 36 months, from empty repo to a multi-hospital command center.
- **Status:** v1 draft, October 2026. Tech choices are recommendations; each one is recorded as an ADR (architecture decision record) in month 1 so it can be challenged and changed.

---

## Contents

1. [Scope and definition of done](#1-scope-and-definition-of-done)
2. [Team and roles](#2-team-and-roles)
3. [Technology stack](#3-technology-stack)
4. [Repository layout](#4-repository-layout)
5. [Core contracts](#5-core-contracts)
6. [Phase plan with epics and tasks](#6-phase-plan-with-epics-and-tasks)
7. [Testing and verification](#7-testing-and-verification)
8. [Regulatory and QMS deliverables](#8-regulatory-and-qms-deliverables)
9. [Security implementation checklist](#9-security-implementation-checklist)
10. [Environments, deployment and operations](#10-environments-deployment-and-operations)
11. [Pilot site readiness checklist](#11-pilot-site-readiness-checklist)
12. [Risks and mitigations](#12-risks-and-mitigations)
13. [First 30 days](#13-first-30-days)
14. [Open decisions](#14-open-decisions)

---

## 1. Scope and definition of done

### 1.1 Minimum viable product (end of Phase 2, ~month 20)

A unit can run Vigil for ECMO and IABP patients with:

- Live data from monitors, ventilators, at least two ECMO console models and at least one IABP model, from at least two vendors.
- Safety-floor rules running on the unit edge, with local alarms and nurse-call integration, working with the core offline.
- Central station and mobile app showing numerics, waveforms, therapy cockpit and alerts.
- Hospital-tuned rule sets for ECMO and IABP, with versioning, replay and two-person approval.
- ADT integration and EHR write-back of alerts and acknowledgements.
- Zero-trust security baseline, audit ledger, SBOM per release.
- Design history file sufficient for a US 510(k) submission of the rules and alarm functions.

### 1.2 Out of scope (all phases)

- Writing settings back to any device (closed-loop control).
- Replacing the bedside monitor's own primary alarms. Vigil is a secondary, distributed alarm system.
- Billing, orders, medication administration (stays in the EHR).

### 1.3 Global definition of done for any feature

A feature is done only when all of these are true:

- [ ] Code merged with review from a second engineer; Class C code also reviewed by the safety owner.
- [ ] Unit tests, plus integration tests against device simulators.
- [ ] Software requirement(s) and risk control(s) linked to the code and tests in the traceability tool.
- [ ] Threat model entry updated if it touches a trust boundary.
- [ ] Replay suite passes with zero unexplained alarm differences.
- [ ] User-facing text reviewed by the clinical lead.
- [ ] Operational runbook entry and dashboards exist for any new service.

---

## 2. Team and roles

Minimum team for the plan as written. Scale squads, not process.

| Squad | People | Owns |
|---|---|---|
| Edge & devices | 4 engineers (Rust/C++), 1 embedded/Linux | Edge OS image, driver SDK, drivers, safety-floor engine, local alarm path |
| Core platform | 4 engineers (Rust/Go), 1 SRE | Event log, stores, alarm manager, integration hub, HA |
| Clinical apps | 3 frontend, 1 mobile, 1 UX designer | Central station, mobile app, command center, rule editor |
| Data & ML | 2 ML engineers, 1 data engineer, 1 clinical data scientist | Feature store, models, model lab, OMOP mart, drift monitoring |
| Security | 1 product security engineer (+ external pen-testers) | Identity, PKI, policy, supply chain, threat models |
| Quality & regulatory | 1 QA/RA lead, 2 verification engineers | QMS, design history file, verification, submissions |
| Clinical | 1 intensivist (part-time), 1 perfusionist, 1 ICU nurse informaticist | Requirements, rule content, usability studies, hazard analysis |
| Product | 1 product manager, 1 engineering manager | Roadmap, pilot sites, vendor agreements |

Named roles the standards require: **safety owner** (signs off risk file), **software configuration manager**, **security officer**, **clinical safety officer** (for UK/DCB0129 if relevant).

---

## 3. Technology stack

Each row becomes an ADR in month 1. "Why" is the deciding reason; "Alternative" is the fallback if the choice fails.

| Area | Choice | Why | Alternative |
|---|---|---|---|
| Edge OS | Yocto-built immutable Linux (or Ubuntu Core) with A/B partitions, dm-verity, TPM 2.0 measured boot | Immutable, signed image; atomic rollback | Ubuntu Pro with hardened profile |
| Edge hardware | Fanless industrial PC, IEC 60601-1 / 62368-1 rated, dual NIC, TPM 2.0, 1 TB SSD | Medical environment, 72 h buffer per unit | Hospital-supplied VM (non-Class C path only) |
| Safety-floor engine and driver host | **Rust** | Memory safety, deterministic performance, good for IEC 62304 Class C | C++ with MISRA subset |
| Rules language | Custom typed DSL compiled to a Rust IR; same `vigil-rules` crate used on edge and core | One engine, two placements; identical behavior is testable | HL7 CQL for imported guidelines only |
| SDC (IEEE 11073) | `sdc11073` (Python, Dräger open source) for simulators; SDCLib/C or OpenSDC for production consumer, wrapped behind the driver ABI | Mature open implementations | Commercial SDC stack |
| HL7 v2 | Rust `hl7-parser` or in-house parser for PCD-01; Mirth/NextGen Connect only for site-specific EHR glue | PCD-01 is narrow and well specified | — |
| Edge bus and replication | NATS JetStream, 3-member cluster (2 edge nodes + 1 witness on core or a mini node) | Lightweight, replicated streams, works offline | Embedded Raft log in Rust |
| Core event log | Apache Kafka (KRaft) or Redpanda, 3+ brokers across 2 zones + tie-breaker | Durable ordered log, replay, ecosystem | Pulsar |
| Numerics store | TimescaleDB (PostgreSQL) | SQL, compression, continuous aggregates | ClickHouse |
| Waveform store | Chunked compressed segments in S3-compatible object storage (MinIO on-prem), index in PostgreSQL | Cheap, immutable, scales | TimescaleDB with large chunks |
| Clinical store | HAPI FHIR R5 server on PostgreSQL | Standard API for EHR and apps | Smile CDR (commercial) |
| Core services | Rust for alarm manager and CDS runtime; Go for integration, API and admin services | Rust where safety-relevant, Go for speed of delivery | All Rust |
| ML training | Python, PyTorch, scikit-learn, MLflow for registry | Standard tooling | — |
| ML inference | ONNX Runtime inside the CDS runtime (Rust bindings) | No Python in the alert path; deterministic versioned artifacts | Triton |
| Orchestration (core) | Kubernetes (RKE2 or OpenShift on-prem; managed K8s for hosted command center) | Standard, HA primitives | Nomad |
| Delivery | Argo CD (GitOps), Helm | Auditable deployments | Flux |
| Workload identity | SPIFFE/SPIRE, mTLS everywhere via Envoy / Istio ambient mesh | Short-lived certs, zero trust | Linkerd |
| Policy | Open Policy Agent (OPA) with Rego policies, decisions logged | Externalised ABAC | Cedar |
| User identity | Keycloak as broker to hospital IdP (OIDC/SAML), WebAuthn/FIDO2 | Works with any hospital SSO | Hospital IdP directly |
| Secrets & keys | HashiCorp Vault + HSM (or cloud KMS for hosted tier) | Per-hospital keys, rotation | — |
| Web apps | React + TypeScript, WebSocket streaming, WebGL waveform renderer | Performance for 30+ live waveforms on one screen | — |
| Mobile | Native Swift and Kotlin (alerts need reliable background push and critical alerts) | Platform alert APIs | React Native with native alert modules |
| Video | WebRTC with self-hosted LiveKit SFU, end-to-end encryption (insertable streams) | Low latency, on-prem possible | Vendor tele-ICU carts via SIP |
| Observability | OpenTelemetry, Prometheus, Grafana, Loki, Tempo | Open standards | — |
| CI/CD | GitHub Actions or GitLab CI, Sigstore cosign, SLSA L3 provenance, Syft (CycloneDX SBOM), Grype/Trivy, Semgrep, cargo-deny | Supply-chain evidence as build output | — |
| Requirements & traceability | Jama, Polarion or Ketryx (links Jira/GitHub to requirements, risks, tests) | Required for 62304 design history | Git-based (Doorstop) for early months |

### 3.1 Web portal stack

The web portal is three apps on one codebase and design system: the **central station** (unit), the **command center** (multi-hospital), and **admin + rule editor**. They share one backend-for-frontend (BFF).

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict mode) | Type safety shared with generated protobuf types |
| Framework | React 18 + Vite | Mature, large talent pool, fast builds |
| Routing & server data | TanStack Router + TanStack Query | Typed routes, caching and retries for REST/FHIR calls |
| Live state | Zustand stores fed by the stream client, outside React render | 30+ patients updating every second without re-rendering the whole tree |
| Streaming transport | WebSocket carrying binary protobuf (`@bufbuild/protobuf`), per-patient subscriptions, sequence numbers and gap detection | Low overhead; client knows when it has missed data and shows it |
| Waveforms | Custom WebGL2 renderer in a Web Worker with OffscreenCanvas (regl or PixiJS as the base) | 60 fps sweep for many waveforms; main thread stays free for alarms and input |
| Trend charts | uPlot | Very fast for long numeric time series |
| UI components | Radix UI primitives + own design system (tokens for IEC 60601-1-8 alarm colors and priorities), documented in Storybook | Accessible primitives; alarm visuals controlled by us, not a theme library |
| Therapy cockpit diagrams | SVG components driven by live values (ECMO circuit, IABP timing) | Crisp at any size; easy to test |
| Video | LiveKit client SDK (WebRTC) with end-to-end encryption | Matches the self-hosted SFU |
| Forms (rule editor, admin) | React Hook Form + Zod; Monaco editor for the rule DSL with a language server for syntax and unit errors | Validated input; rule authors see errors as they type |
| Internationalization | FormatJS (react-intl), UCUM-aware unit formatting | Multi-country deployments; correct units |
| Accessibility | WCAG 2.2 AA; axe-core checks in CI | Required by hospitals and public tenders |
| Authentication | OIDC Authorization Code + PKCE through Keycloak; WebAuthn/FIDO2 and badge tap; tokens held by the BFF, browser gets an HttpOnly, SameSite=Strict session cookie | No tokens in browser storage |
| Browser security | Strict CSP with nonces, Trusted Types, Subresource Integrity, no third-party scripts or CDNs at runtime, HSTS, frame-ancestors none | Blocks XSS and supply-chain injection |
| BFF | Go service (`core/api-gateway`): REST + WebSocket fan-out, gRPC to core services, OPA check on every request, PHI field filtering per role | One place to enforce policy and shape data for the UI |
| Hosting | Static assets built once, signed, served by Envoy/NGINX inside the hospital core cluster; hosted command center on managed Kubernetes behind a WAF | Works on-prem with no internet; same artifact everywhere |
| Workstations | Central station runs as a locked-down Chromium kiosk on managed thin clients; command center on standard managed desktops | Predictable rendering and no stray extensions |
| Feature flags | OpenFeature with self-hosted Unleash | Staged rollouts per unit without redeploying |
| Telemetry | OpenTelemetry web SDK to the internal collector, with PHI scrubbing; frontend error tracking via self-hosted Sentry | Find UI failures without leaking patient data |
| Testing | Vitest (unit), React Testing Library, Playwright (end-to-end against simulators), visual regression on Storybook, performance budget tests for the waveform renderer | Catches regressions in the screens clinicians rely on |

Portal-specific rules:

- **Alarm display never depends on React rendering.** Alarms come through a dedicated stream channel and a small alarm layer that is tested on its own; a crash elsewhere in the UI shows a full-screen fallback that still lists active alarms.
- **Staleness is visible.** Every live value shows its age; if the stream gaps for more than 5 s, the patient tile greys out and says "no live data".
- **The operating-level banner (levels 0–3) is part of the app shell** and cannot be hidden.

---

## 4. Repository layout

One monorepo with strict ownership (CODEOWNERS) and per-component safety class labels.

```
vigil/
├── docs/
│   ├── adr/                     # architecture decision records
│   ├── dhf/                     # design history file sources (generated docs land in build/)
│   ├── threat-models/
│   └── runbooks/
├── proto/                       # protobuf contracts (single source of truth)
│   └── vigil/v1/{envelope,observation,waveform,association,alert,therapy,audit}.proto
├── edge/                        # SAFETY CLASS C unless marked
│   ├── os-image/                # Yocto layers, A/B update, dm-verity
│   ├── driver-sdk/              # driver ABI, sandbox launcher, seccomp profiles
│   ├── drivers/                 # one crate per device family (each Class C)
│   ├── normalizer/              # MDC/LOINC/UCUM mapping
│   ├── sqi/                     # signal quality index
│   ├── timesync/
│   ├── safety-engine/           # hosts vigil-rules for the safety floor
│   ├── local-alarm/             # display + nurse call adapters
│   └── forwarder/               # store-and-forward to core
├── shared/
│   ├── vigil-rules/             # DSL parser, type checker, compiler, runtime (Class C)
│   ├── vigil-time/              # bitemporal types
│   └── vigil-codes/             # terminology tables
├── core/
│   ├── ingest/                  # edge → Kafka gateway
│   ├── stores/{timeseries,waveform,fhir-sync}/
│   ├── cds-runtime/             # rules + ONNX inference + arbitration (Class B)
│   ├── alarm-manager/           # priority, routing, escalation (Class B)
│   ├── integration/{adt,ehr-writeback,nurse-call,registry-elso}/
│   ├── api-gateway/             # BFF for apps, WebSocket streams
│   ├── audit-ledger/
│   └── admin/                   # rule management, config, users
├── apps/
│   ├── central-station/
│   ├── command-center/
│   ├── rule-editor/
│   ├── mobile-ios/
│   └── mobile-android/
├── ml/
│   ├── features/                # feature definitions shared train/serve
│   ├── models/{ecmo-oxy-failure,deterioration,crrt-filter-life,...}/
│   ├── model-cards/
│   └── lab/                     # de-identified training pipelines, OMOP mart
├── simulators/                  # device simulators (SDC, HL7, vendor serial), patient scenario player
├── test/
│   ├── replay/                  # recorded ICU days + expected alarm outputs
│   ├── hil/                     # hardware-in-the-loop rigs
│   ├── chaos/                   # fault-injection scenarios
│   └── perf/
├── deploy/
│   ├── helm/
│   ├── argocd/
│   └── terraform/               # hosted tier
└── tools/                       # traceability export, SBOM, release evidence bundle
```

---

## 5. Core contracts

Freeze these in Phase 0. Every later component depends on them. All are protobuf in `proto/vigil/v1/`, with JSON mappings for the web.

### 5.1 Event envelope

Every message on the edge bus and the core log uses this wrapper.

```protobuf
message Envelope {
  string event_id        = 1;  // UUIDv7, time-ordered
  string tenant_id       = 2;  // hospital
  string unit_id         = 3;
  string source_id       = 4;  // device or service SPIFFE ID
  google.protobuf.Timestamp valid_time    = 5;  // when it was true at the bedside
  google.protobuf.Timestamp recorded_time = 6;  // when Vigil recorded it
  int64  clock_offset_us = 7;  // measured device clock offset at valid_time
  string schema          = 8;  // e.g. "vigil.v1.Observation"
  bytes  payload         = 9;
  Provenance provenance  = 10;
}

message Provenance {
  string driver_id      = 1;
  string driver_version = 2;
  string edge_node_id   = 3;
  bool   late_arrival   = 4;  // backfilled after an outage
}
```

### 5.2 Observation

```protobuf
message Observation {
  string association_id = 1;  // device↔encounter binding, never a bare bed
  string code_system    = 2;  // "MDC", "LOINC", "VIGIL"
  string code           = 3;  // e.g. MDC_PRESS_BLD_ART_MEAN
  double value          = 4;
  string unit_ucum      = 5;
  double raw_value      = 6;
  string raw_unit       = 7;
  float  sqi            = 8;  // 0..1 signal quality
  repeated string flags = 9;  // "ARTIFACT", "FLUSH", "LEAD_OFF", "SETTING"
}
```

### 5.3 Device association

```protobuf
message DeviceAssociation {
  string association_id = 1;
  string device_id      = 2;
  string encounter_id   = 3;
  string therapy_episode_id = 4;  // optional
  google.protobuf.Timestamp start = 5;
  google.protobuf.Timestamp end   = 6;  // open while active
  AssociationMethod method = 7;   // ADT_ONLY, BARCODE, NFC, SDC_CONTEXT
  bool   confirmed  = 8;          // therapy rules run only when true
}
```

### 5.4 Alert

```protobuf
message Alert {
  string alert_id        = 1;
  string encounter_id    = 2;
  Priority priority      = 3;  // per IEC 60601-1-8: HIGH, MEDIUM, LOW, ADVISORY
  string problem_key     = 4;  // groups findings into one clinical problem
  repeated Finding findings = 5;
  AlertState state       = 6;  // ACTIVE, ACKNOWLEDGED, ESCALATED, RESOLVED, DISMISSED
  string explanation     = 7;  // human-readable, clinical-lead-approved template
  repeated string evidence_event_ids = 8;
  Origin origin          = 9;  // EDGE_SAFETY_FLOOR or CORE
}

message Finding {
  oneof source { RuleHit rule = 1; ModelHit model = 2; }
}
message RuleHit  { string rule_id = 1; string rule_version = 2; }
message ModelHit { string model_id = 1; string model_version = 2;
                   float probability = 3; float ci_low = 4; float ci_high = 5;
                   int32 lead_time_min = 6; repeated Contribution top_features = 7; }
```

### 5.5 Rule DSL (example)

```
rule ecmo.oxygenator_failure_trend v3
  owner      "ECMO program lead"
  applies_to therapy ECMO
  priority   MEDIUM
  safety_floor false

  let dp      = trend(ECMO_OXY_DELTA_P, window 6h, min_sqi 0.8)
  let post_o2 = latest(BG_POST_OXY_PO2, max_age 4h)
  let sweep   = setting(ECMO_SWEEP_FLOW)

  when dp.slope > 2 mmHg/h
   and post_o2 < 200 mmHg
   and sweep.unchanged_for(2h)
  for 15 min                       // persistence
  clear_when dp.slope < 1 mmHg/h for 30 min   // hysteresis

  explain "Oxygenator pressure drop rising {dp.slope} mmHg/h with post-oxygenator PO2 {post_o2}."

  test "fires on clotting oxygenator"   scenario "ecmo/oxy_clot_01"     expect fire within 30 min
  test "silent on stable run"           scenario "ecmo/stable_va_01"    expect no_fire
  test "silent on flush artifact"       scenario "ecmo/flush_artifact"  expect no_fire
```

Compiler rules: units are type-checked (mmHg vs kPa is a compile error, not a runtime conversion bug); every rule must declare at least one firing and one non-firing test; `safety_floor true` rules may use only functions marked Class C.

### 5.6 Model interface

```text
Model artifact = ONNX file + manifest.yaml:
  id, version, therapy, input_features[] (names from ml/features), output (probability),
  calibration (isotonic table), min_input_sqi, max_staleness per input,
  intended_use, contraindications, validation_report_uri, pccp_bounds
```

The CDS runtime refuses to load a model whose manifest is unsigned, whose features are unknown, or whose PCCP bounds are exceeded by its own validation report.

### 5.7 External APIs

| API | Protocol | Consumers |
|---|---|---|
| Live stream | WebSocket (binary protobuf), per-encounter subscriptions | Central station, command center |
| Query | REST/JSON + FHIR R5 | Apps, EHR, analytics |
| Alerts out | FHIR `DetectedIssue` + `Communication`, HL7 v2 ORU for legacy EHRs | EHR write-back |
| ADT in | HL7 v2 ADT A01–A08, A11–A13, A17 | Integration hub |
| Nurse call | Vendor adapters (Ascom, Vocera/Stryker, Rauland) | Local alarm, alarm manager |
| Mobile push | APNs / FCM (payload contains no PHI, app fetches details over mTLS) | Mobile apps |
| Registry | ELSO data export (CSV/API per ELSO spec) | ECMO program |

---

## 6. Phase plan with epics and tasks

Durations assume the team in section 2. Phases overlap deliberately.

```
Month:        0    3    6    9    12   15   18   21   24   27   30   33   36
Phase 0       ████
Phase 1            ██████████████
Phase 2                       ████████████████
Phase 3                                      ████████████████
Phase 4                                                ████████████████████
Regulatory    QMS──────────────────── 510(k) #1 ──────── PCCP/510(k) #2 ── MDR
```

### Phase 0: Foundations (months 0–3)

**Goal:** a team that can ship traceable, signed, tested code into a simulated ICU.

| # | Epic | Key tasks | Acceptance criteria |
|---|---|---|---|
| 0.1 | QMS and design controls | Adopt ISO 13485 procedures (design control, CAPA, document control, supplier); select traceability tool; write Software Development Plan (62304 §5.1) and Risk Management Plan (14971) | Procedures approved; SDP lists safety classes per component |
| 0.2 | ADRs | Write ADRs for every row of section 3 | ADRs merged and signed by engineering lead and safety owner |
| 0.3 | Monorepo and CI | Repo skeleton (section 4); CI with build, test, lint, Semgrep, cargo-deny, Syft SBOM, cosign signing, SLSA provenance | Every merge produces a signed artifact + SBOM; unsigned artifacts cannot deploy |
| 0.4 | Contracts | Write and freeze `proto/vigil/v1/*` (section 5); generate Rust, Go, TS bindings | Contracts v1.0 tagged; breaking changes need ADR |
| 0.5 | Simulators | Patient scenario player; SDC monitor simulator via `sdc11073`; HL7 PCD-01 simulator; first ECMO console simulator from vendor docs | 20-bed simulated unit streams 24 h without gaps |
| 0.6 | Hazard analysis v0 | Preliminary hazard analysis with clinical team: missed alarm, false alarm, wrong patient, stale data, wrong unit, outage | Hazard list with initial risk controls feeding requirements |
| 0.7 | Threat model v0 | STRIDE over the architecture diagram; trust boundaries | Threat list with mitigations feeding security requirements |
| 0.8 | Vendor access | Start data-sharing / SDK agreements with ECMO, IABP, monitor vendors | At least 2 ECMO + 1 IABP vendor in signed or late-stage agreement |
| 0.9 | Clinical requirements | ECMO and IABP user needs, workflows, alarm priorities with clinical team | User needs document approved |

### Phase 1: Edge, devices and safety floor (months 3–12)

**Goal:** a unit edge pair that ingests real devices and raises safety-floor alarms with no core present.

| # | Epic | Key tasks | Acceptance criteria |
|---|---|---|---|
| 1.1 | Edge OS image | Yocto image, A/B update, dm-verity, measured boot, TPM key sealing, disk encryption, no inbound ports | Image boots only when signed; tampered image refuses to boot; rollback tested |
| 1.2 | Driver SDK | Driver ABI (protobuf over Unix socket), sandbox launcher (separate user, seccomp, cgroups, no network except device), watchdog | Killing a driver restarts it in < 2 s with no effect on other drivers |
| 1.3 | Drivers (wave 1) | SDC consumer; HL7 PCD-01; 2 ECMO consoles; 1 IABP; 2 ventilators; 1 blood gas analyzer; 1 monitor gateway | Each driver passes conformance suite against simulator and real device in lab |
| 1.4 | Normalizer & terminology | MDC/LOINC/UCUM mapping tables, unit conversion, raw value retention | 100% of wave-1 parameters mapped; unmapped values flagged, never dropped |
| 1.5 | Time sync | PTP on edge, offset measurement per device, drift alarm > 500 ms | Clock skew injection produces drift alarm and correct timestamps |
| 1.6 | SQI | Per-channel quality: flatline, saturation, lead-off, arterial line damping/flush, motion | SQI validated on labelled artifact set; precision/recall reported |
| 1.7 | Association | ADT-driven association, barcode/NFC confirmation UI on edge display, association audit | Therapy rules do not run until association confirmed (tested) |
| 1.8 | `vigil-rules` engine | Parser, type checker with units, compiler to IR, deterministic runtime, test harness | Fuzzed parser; 100% MC/DC coverage on runtime core (Class C) |
| 1.9 | Safety-floor rule set | Clinically approved minimal set for ECMO (flow loss, access pressure, circuit disconnect proxies), IABP (trigger loss, augmentation loss), plus device-communication-lost | Each rule has firing + non-firing tests; clinical sign-off |
| 1.10 | Local alarm path | Edge display UI, nurse-call adapters, IEC 60601-1-8 priority sounds and colors, alarm acknowledgement | Device sample → local alarm ≤ 1 s p99 measured on HIL rig |
| 1.11 | Edge replication | NATS JetStream 3-member cluster; sample acknowledged only after write to both nodes; 72 h retention | Pull power on either node: no data loss, no alarm gap |
| 1.12 | Forwarder | Store-and-forward to core with ordered backfill, `late_arrival` flag | 24 h core outage backfills completely and in order |

**Phase 1 exit:** safety-floor demo in the lab with real devices, core switched off, observed by clinical team. Verification report for Class C components drafted.

### Phase 2: Core, apps and ECMO/IABP pilot (months 9–20)

**Goal:** the MVP in section 1.1, live at two pilot ICUs.

| # | Epic | Key tasks | Acceptance criteria |
|---|---|---|---|
| 2.1 | Core cluster | Kubernetes across 2 zones + tie-breaker; Kafka; TimescaleDB with streaming replication; MinIO; Vault; SPIRE; Istio ambient | Zone loss: RTO < 30 s, RPO 0 for alerts (chaos test) |
| 2.2 | Ingest & stores | Edge→Kafka gateway with mTLS; numerics to Timescale; waveform chunker to object store; FHIR sync | Rebuild every store from the log in a test environment, byte-identical outputs |
| 2.3 | Therapy episodes | Episode lifecycle (start, circuit component changes, settings, end), linking associations | Oxygenator age and sweep history queryable for any timestamp |
| 2.4 | CDS runtime (rules) | Run full rule sets on core using same `vigil-rules` crate; dedup with edge-origin alerts | Same scenario produces identical rule hits on edge and core |
| 2.5 | Alarm manager | Problem grouping, priority, routing by assignment, escalation ladder, acknowledgement, time-limited context suppression (not for safety floor) | Escalation timings met in test; suppression always logged and expiring |
| 2.6 | Integration hub | ADT in, EHR write-back (FHIR + HL7 ORU), nurse-call, ELSO export | Interfaces certified with pilot site EHR team |
| 2.7 | Rule governance | Rule editor UI; versioning; two-person approval; 30-day replay impact report; staged rollout | A rule change cannot go live without approval and replay report |
| 2.8 | Central station | Unit overview, patient view, WebGL waveforms, therapy cockpit (ECMO circuit, IABP), alert list, operating-level banner | Usability formative study x2; 30 beds rendered at 60 fps on target hardware |
| 2.9 | Mobile apps | Alert delivery with critical alert entitlement, acknowledge/escalate, waveform snapshot, badge/passkey login | Push to phone p95 < 5 s; no PHI in push payload |
| 2.10 | Identity & policy | Keycloak broker to hospital IdP, FIDO2, OPA care-relationship policy, break-glass flow, audit ledger | Pen test of auth flows passes; break-glass generates review task |
| 2.11 | Operating levels | Health model across tiers; level 0–3 banner on every screen; synthetic patient heartbeat | Each failure mode in design table shows correct level within 10 s |
| 2.12 | Pilot | Site validation, training, observational ("silent") mode 8 weeks, then live with ECMO/IABP | Pilot success criteria met (section 11) |
| 2.13 | Submission #1 | 510(k) for rules + alarm functions; cybersecurity 524B package | Submitted; pre-sub feedback addressed |

### Phase 3: Predictive layer and more therapies (months 18–30)

**Goal:** validated models live under a change control plan; therapy coverage beyond ECMO/IABP.

| # | Epic | Key tasks | Acceptance criteria |
|---|---|---|---|
| 3.1 | Model lab | De-identification pipeline (date shift, ID tokenization), OMOP mart, MLflow registry, access controls | Re-identification risk assessment signed off; no PHI in lab |
| 3.2 | Feature store | Shared feature definitions in `ml/features`, identical code path for training and serving, point-in-time correct with bitemporal data | Train/serve skew test passes on replay data |
| 3.3 | Models (wave 1) | ECMO oxygenator failure; general deterioration (ICU); CRRT filter life; VA-ECMO weaning readiness | Each has model card, external validation at ≥ 1 non-training site, subgroup metrics, calibration |
| 3.4 | Inference in CDS runtime | ONNX Runtime, manifest checks, SQI gating, explanations (top features), uncertainty | Inference p99 < 200 ms per patient per cycle |
| 3.5 | Arbitration | Merge rule and model findings into problems; enforce "model can't lower a rule"; ranking | Property test: no model output ever reduces a rule alert's priority |
| 3.6 | Shadow mode & drift | Per-site shadow deployment, local calibration check, drift dashboards, owner alerts | Go-live requires shadow report sign-off by clinical lead |
| 3.7 | PCCP | Predetermined Change Control Plan: allowed retraining, performance bounds, validation protocol | Accepted in FDA submission #2 |
| 3.8 | Therapy modules | Impella/VAD, CRRT, ventilation, vasoactives (VIS score); drivers wave 2 | Each module goes through the same rule + hazard + usability process |
| 3.9 | Alarm metrics | Alarms per bed-day, % actionable, time to ack, per unit | Pilot units see ≥ 30% fewer non-actionable alerts vs baseline (target) |

### Phase 4: Network command center and scale (months 24–36)

**Goal:** remote surveillance across hospitals; certifications for hosted services.

| # | Epic | Key tasks | Acceptance criteria |
|---|---|---|---|
| 4.1 | Hosted tier | Multi-tenant command-center backend; per-tenant keys; outbound-only tunnels from hospitals; data residency per region | Tenant isolation pen test passes |
| 4.2 | Command center app | Network acuity worklist, therapy filters, multi-patient waveform wall, handoff ownership | Formative + summative usability with remote intensivists |
| 4.3 | Telepresence | LiveKit SFU, E2E encryption, in-room indicator, camera audit, privacy mode | Video starts < 3 s; camera activation always audited |
| 4.4 | Specialist links | Time-limited, single-patient scoped access for perfusionists/consultants | Access expires automatically; audited |
| 4.5 | Certifications | SOC 2 Type II, ISO 27001, HITRUST (if US customers require) | Audit reports issued |
| 4.6 | EU | MDR technical file (Class IIb expected), AI Act documentation, GDPR DPIA template, notified body audit | CE mark |
| 4.7 | Scale | 50+ beds per edge pair, 1,000+ beds per command center, load tests | Perf targets in section 7.4 met at 2x expected load |

---

## 7. Testing and verification

### 7.1 Test pyramid

| Level | What | Where |
|---|---|---|
| Unit | Every crate/package; MC/DC coverage for Class C, branch coverage ≥ 80% for Class B | CI on every commit |
| Property & fuzz | Rule parser, HL7/SDC parsers, arbitration invariants | CI nightly (cargo-fuzz, proptest) |
| Contract | Protobuf compatibility (buf breaking), FHIR profile validation | CI on every commit |
| Integration | Services against simulators in a full simulated unit | CI per merge to main |
| Replay | Library of recorded/synthetic ICU days; expected alarm outputs stored as golden files | Every release candidate; any diff must be explained and approved |
| Hardware-in-the-loop | Real devices + edge pair on a rig with programmable patient simulators (e.g. ECMO mock loop with flow/pressure control) | Weekly and every release |
| Chaos | Node kill, zone loss, network partition, clock skew, disk full, driver crash, certificate expiry | Every release; results in release evidence |
| Performance | Latency and throughput (7.4) | Every release |
| Usability | Formative studies each phase; summative before each submission (IEC 62366-1) | Per phase |
| Clinical | Silent-mode comparison at pilot sites; post-market performance follow-up | Pilot and after launch |

### 7.2 Replay library contents

- At least 200 annotated ECMO days and 100 IABP days by Phase 2 exit (from partner sites, de-identified, plus synthetic).
- Scenario tags: true events, artifacts, flushes, transport, device swaps, outages, late labs.
- Each safety-floor rule must be exercised by ≥ 3 positive and ≥ 3 negative scenarios.

### 7.3 Release evidence bundle (generated per release)

Signed bundle containing: SBOM + VEX, SLSA provenance, test reports, coverage, replay diff report, chaos results, traceability matrix (requirement → risk control → code → test), open anomaly list with risk assessment, threat model diff.

### 7.4 Performance targets

| Metric | Target |
|---|---|
| Device sample → local alarm | ≤ 1 s p99 |
| Device sample → central station numerics | ≤ 2 s p99 |
| Waveform added latency to remote screen | ≤ 1 s p99 |
| Alert → phone push | ≤ 5 s p95 |
| Core failover | < 30 s |
| Edge node loss | 0 s gap |
| Model inference per patient cycle | < 200 ms p99 |
| Central station render | 30 beds, 60 fps |

---

## 8. Regulatory and QMS deliverables

Map of the IEC 62304 / ISO 14971 / IEC 62366-1 file to phases. "Draft" means v0 exists; "Final" means approved for submission.

| Deliverable | Standard | P0 | P1 | P2 | P3 | P4 |
|---|---|---|---|---|---|---|
| Software Development Plan | 62304 §5.1 | Final | Update | Update | Update | Update |
| Software Requirements Spec | 62304 §5.2 | Draft | Update | Final (MVP) | Update | Update |
| Software Architecture + segregation rationale | 62304 §5.3 | Draft | Final (edge) | Final (core) | Update | Update |
| Detailed design (Class C units) | 62304 §5.4 | — | Final | — | — | — |
| Unit/integration/system verification | 62304 §5.5–5.7 | — | Edge | MVP | Models | Hosted |
| SOUP list + risk assessment | 62304 §7.1 | Draft | Update | Final | Update | Update |
| Risk Management File | ISO 14971 | Plan + PHA | Update | Final (MVP) | Update | Update |
| Usability Engineering File | IEC 62366-1 | Plan | Formative | Summative | Formative | Summative |
| Cybersecurity documentation | FDA 524B, IEC 81001-5-1 | Threat model v0 | Update | Final | Update | Update |
| Clinical evaluation / performance | MDR, FDA | — | — | Pilot data | Model validation | CER |
| Model cards, PCCP | FDA AI/ML guidance | — | — | — | Final | Update |
| Post-market surveillance plan | ISO 13485, MDR | — | — | Final | Update | Update |

**Regulatory milestones**

- Month 6: FDA pre-submission (Q-Sub) on classification, predicates and the edge/core split.
- Month 18: 510(k) #1 (rules + alarm functions, ECMO/IABP).
- Month 28: submission #2 with predictive models and PCCP.
- Month 30: EU notified body audit; MDR technical file.

---

## 9. Security implementation checklist

Owned by the product security engineer; each item has an issue and a test.

**Identity and access**
- [ ] SPIRE deployed; every workload has a SPIFFE ID; cert TTL ≤ 1 h.
- [ ] Edge node identity bound to TPM; enrolment ceremony documented.
- [ ] Keycloak brokered to hospital IdP; WebAuthn required for clinical roles.
- [ ] OPA policies: care relationship, unit assignment, role, location; decisions logged.
- [ ] Break-glass with reason, banner, same-day review task.
- [ ] Session timeout 15 min idle on shared stations with badge tap-to-resume.

**Network**
- [ ] Device VLAN with 802.1X / MAB; edge is the only bridge.
- [ ] No inbound ports on edge; core ingress only via Envoy with mTLS.
- [ ] Default-deny network policies in Kubernetes.
- [ ] Outbound-only tunnel to hosted tier; egress allow-list.

**Data**
- [ ] AES-256 at rest everywhere; per-tenant keys in Vault/HSM; key rotation runbook.
- [ ] Field-level encryption for direct identifiers.
- [ ] Audit ledger hash-chained, anchored daily (e.g. signed checkpoint), streamed to SIEM.
- [ ] Push notifications contain no PHI.
- [ ] De-identification pipeline reviewed by privacy officer.

**Supply chain and build**
- [ ] Signed commits on protected branches; two-person review.
- [ ] Hermetic, reproducible builds; SLSA L3 provenance.
- [ ] SBOM (CycloneDX) + VEX per release; nightly vulnerability scan against all supported releases.
- [ ] Driver packages signed; edge refuses unsigned drivers.
- [ ] Third-party (SOUP) intake review.

**Assurance and response**
- [ ] STRIDE threat model per component, reviewed each release.
- [ ] Annual external pen test + before each submission; summary published.
- [ ] Coordinated vulnerability disclosure policy and security.txt; public advisory page.
- [ ] Bug bounty after first commercial release.
- [ ] Patch SLA: critical within 30 days, interim mitigation guidance within 7 days.
- [ ] MDS2 form published.
- [ ] Public security whitepaper v1 at first commercial release.

---

## 10. Environments, deployment and operations

| Environment | Purpose | Data |
|---|---|---|
| dev | Engineers, per-branch preview of core and apps | Synthetic only |
| sim-unit | Full simulated 20-bed ICU, 24/7, replay and chaos | Synthetic + replay |
| hil-lab | Real devices and edge hardware | Simulated patients |
| staging (per customer) | Site config, interface testing with EHR test systems | Hospital test data |
| production (per hospital) | Edge pairs per unit, core cluster per hospital/health system | PHI |
| hosted (per region) | Command center, model lab | PHI (command center), de-identified (lab) |

**Release process**

1. Release candidate cut; evidence bundle generated (7.3).
2. Safety owner and QA approve; regulatory assesses change impact (letter-to-file vs new submission).
3. Staged rollout: sim-unit → hil-lab → one pilot unit (canary, 72 h) → rest of site → other sites.
4. Edge updates only in hospital-approved windows; automatic rollback on health-check failure.

**Operations**

- 24/7 on-call for core and hosted tier; synthetic patient heartbeat pages on-call if an end-to-end test alarm is missed.
- Runbooks for every operating level transition and every failure mode in the design table.
- Monthly reliability review: incidents, alarm latency, availability, near misses fed to CAPA and the risk file.

---

## 11. Pilot site readiness checklist

**Before install**
- [ ] Executive sponsor, ICU medical director, nurse manager, ECMO program lead, biomed, IT security, EHR team named.
- [ ] Data use / BAA / research agreements signed; IRB decision for silent-mode evaluation.
- [ ] Device inventory with models, firmware, connectivity; gaps identified.
- [ ] Network design approved (device VLAN, edge placement, core hosting).
- [ ] EHR interface specs agreed (ADT, write-back).
- [ ] Local rule sets reviewed and approved by the site's clinical committee.

**Silent mode (8 weeks)**
- [ ] Vigil runs live but alerts go only to the evaluation team.
- [ ] Every alert reviewed: true positive, false positive, missed event (from chart review).
- [ ] Latency and availability measured against targets.

**Go-live criteria**
- [ ] Zero missed safety-floor events in silent mode, or each explained and fixed.
- [ ] Alert positive predictive value at or above the site-agreed threshold per rule.
- [ ] Staff training ≥ 90% completion; super-users on every shift.
- [ ] Downtime procedure tested (simulated core outage on a live unit with clinical staff).

**After go-live**
- [ ] Weekly review for 3 months, then monthly.
- [ ] Alarm metrics dashboard shared with unit leadership.

---

## 12. Risks and mitigations

| Risk | Impact | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Therapy device vendors restrict protocol access | High | High | Start agreements in Phase 0; prioritize SDC-capable devices; partner incentives (registry data, co-marketing) | Product |
| Too little ECMO data to validate models | High | Medium | Multi-center consortium; federated training; start with rules, ship models only when validated | Data & ML |
| Class C scope creeps into core | Medium | Medium | Architecture rule: only edge safety path is Class C; segregation reviewed each release | Safety owner |
| Alarm fatigue undermines adoption | High | Medium | Problem-level grouping; silent-mode tuning; per-unit metrics | Clinical lead |
| Regulatory classification differs from assumption | High | Medium | FDA Q-Sub at month 6; early notified body engagement | QA/RA |
| Hospital IT cannot host a 2-zone core | Medium | Medium | Offer appliance bundle and private-cloud option; edge still safe without core | Core platform |
| Cyber incident at a pilot | High | Low | Zero trust, no device write-back, IR plan, tabletop exercises | Security |
| Key-person dependency on clinical experts | Medium | Medium | Clinical advisory board across 3+ sites | Product |

---

## 13. First 30 days

Concrete starting tasks. Each is a ticket.

**Week 1**
- [ ] Create monorepo with layout from section 4; CODEOWNERS; branch protection; signed commits.
- [ ] CI skeleton: build Rust/Go/TS, unit tests, Semgrep, cargo-deny, Syft SBOM, cosign.
- [ ] Write ADR-001 (monorepo), ADR-002 (Rust for edge), ADR-003 (event log choice).
- [ ] Kick off QMS: document control, SDP outline, risk management plan outline.
- [ ] Clinical workshop 1: ECMO and IABP user needs.

**Week 2**
- [ ] Draft `proto/vigil/v1` envelope, observation, association, alert.
- [ ] `sdc11073` monitor simulator streaming into a stub edge bus (NATS).
- [ ] Patient scenario format (YAML timeline of physiology + device events) and a player.
- [ ] Vendor outreach letters to ECMO / IABP / ventilator makers.

**Week 3**
- [ ] `vigil-rules`: grammar, parser, AST, unit type system prototype.
- [ ] First 3 example rules with tests, run against the scenario player.
- [ ] Preliminary hazard analysis workshop.
- [ ] STRIDE session on the architecture diagram.

**Week 4**
- [ ] Driver ABI v0 and sandbox launcher prototype (one SDC driver in a sandbox).
- [ ] Demo: simulated ECMO oxygenator clot scenario → driver → normalizer → rule → console alert.
- [ ] Freeze contracts v0.9 for review; ADRs for remaining stack rows scheduled.
- [ ] Hiring plan confirmed against section 2.

---

## 14. Open decisions

Record the answer as an ADR when made.

1. **Hosting model for the core:** hospital-run, vendor-managed appliance, or private cloud? (Affects Phase 2 effort and SOC 2 scope.)
2. **First market:** US (510(k) first) or EU (MDR first)? The plan assumes US first.
3. **Build vs partner for telepresence:** own LiveKit-based video, or integrate existing tele-ICU carts?
4. **Rules language:** custom DSL (plan default) or CQL-first? DSL gives unit type safety and Class C suitability; CQL gives standards alignment.
5. **Edge witness:** third mini node per unit, or witness on the core (which weakens core-down guarantees for replication but not for alarms)?
6. **Pilot sites:** which two ICUs, and do they run ECMO programs large enough (≥ 50 runs/year) for meaningful silent-mode data?
