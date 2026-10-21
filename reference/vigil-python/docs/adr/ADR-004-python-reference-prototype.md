# ADR-004: Python reference prototype before the Rust/Go/TypeScript build

- **Status:** Proposed
- **Date:** 2026-10-21
- **Deciders:** engineering lead, safety owner (sign-off pending)

## Context

The plan (§3, §3.1) chooses Rust for the edge and the rules engine, Go for the BFF, and React with TypeScript
for the portal. The first development machine has only Python 3 installed: no Rust, Go, Node or protoc.
The week-4 demo (§13) still needs to run end to end.

## Decision

Build the first vertical slice in Python, using only the standard library. It keeps the §4 layout and the
`proto/vigil/v1` contracts.

It serves as the **executable specification**:
- The rule-language grammar, unit type rules, and persistence and hysteresis semantics.
- The scenario format and the golden alarm outputs of the replay tests.

The Rust `vigil-rules` crate and the production drivers must reproduce the same alarm times on the same
scenarios (plan 2.4, "identical rule hits").

## Consequences

- Nothing in this slice is Class C software. It must not run against patients.
- The Python simulators can stay as test tooling, as the plan already intends for `sdc11073`.
- When the production toolchains are available, port in this order:
  1. `vigil-rules`
  2. Driver SDK
  3. Portal (React + TypeScript per §3.1, with WebSocket protobuf replacing the JSON polling API)
