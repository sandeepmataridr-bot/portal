# ADR-005: Single TEST / LIVE operating-mode switch

- **Status:** Proposed
- **Date:** 2026-10-21

## Context

The same edge software must run against simulated patients (development, sim-unit, rule replay) and against
real devices. If simulated data reached a real alarm path, or real data were filed as test data, it would be a
patient-safety hazard ("wrong patient" and "false alarm" in the preliminary hazard analysis).

## Decision

One boolean, `live_mode` in `vigil.toml`, can be overridden by `VIGIL_LIVE_MODE`. It is resolved once at
start-up, and the mode is enforced at several independent points:

1. **Configuration.**
   - TEST identities must start with `sim`; LIVE identities must not.
   - LIVE refuses to start with an incomplete `[live]` section.
2. **Driver host.** It refuses drivers marked `simulated` in LIVE mode.
3. **Edge node.**
   - LIVE requires the wall clock.
   - TEST refuses a nurse-call adapter.
   - Envelopes carry `test_mode`, and the node rejects envelopes from the other mode.
4. **Alarms.**
   - Alerts carry `test_mode`.
   - The nurse-call adapter refuses TEST alerts.
   - The console and the website label every TEST alert.
5. **Audit.** Each mode writes its own ledger.

## Consequences

Switching modes means a restart, by design. The rule test harness always runs simulated and in memory, so it
is allowed in either mode and writes nothing to the audit ledger or nurse call.
