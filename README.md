# Infusion Platform

Fleet dashboard + master registry for a hospital infusion-pump system. Full architecture and rationale: `C:\Users\rpava\.claude\plans\understand-this-project-compressed-wirth.md`.

Rebuilt from scratch in React + NestJS, using `I:\infusion_server` (Flask) only as a read-only functional reference — never edited, never migrated.

## Layout

- `apps/api` — NestJS backend (fleet dashboard, master registry, sync hub)
- `apps/web` — React (Vite) frontend
- `packages/shared-types` — zod schemas + the infusion state machine/cap logic, shared by both apps and by `docs/sync-contract.md`
- `packages/vigil` — Vigil ECMO monitoring engine (rule language, signal quality, alarms, hash-chained audit, scenario simulators); runs inside the API, shown on the web's `/central-station` — see `docs/vigil/README.md`
- `reference/vigil-python` — the Python reference prototype Vigil was ported from (read-only executable spec, ADR-004/006)
- `infra/docker` — local dev Postgres + Redis
- `docs/sync-contract.md` — the protocol the future Android pump-controller app implements against
- `docs/vigil/` — Vigil plan, ADRs, protobuf contracts and integration guide

## Getting started

```sh
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d
cp apps/api/.env.example apps/api/.env   # then fill in real secrets
cp apps/web/.env.example apps/web/.env
pnpm --filter @infusion/api prisma:generate
pnpm --filter @infusion/api prisma:migrate
pnpm dev
```

## Why this exists

The reference Flask app has no real enforcement of its own `high_alert` medicine flag, no dosage/rate caps at all, a machine-auth path that silently allows requests when no credential is configured, and secrets stored as plaintext files in the repo. This rebuild fixes those and adds the fleet-dashboard / autonomous-edge-machine architecture described in the plan.
