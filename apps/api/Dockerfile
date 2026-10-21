# Multi-stage build for @infusion/api. Build context must be the monorepo
# root (pnpm workspace needs the root lockfile + packages/shared-types and
# packages/vigil — the Vigil engine, whose rules/ and scenarios/ ship with it).
#
#   docker build -f apps/api/Dockerfile -t infusion-api .
#
# Uses `pnpm deploy` (pnpm's own workspace-deploy command) instead of
# hand-copying node_modules across stages — pnpm's monorepo node_modules is
# a tree of symlinks into a shared content-addressable store, which does not
# survive being copied piecemeal between Docker build stages. `pnpm deploy`
# resolves that into a flat, real-files-only, prod-only node_modules that
# copies cleanly. See https://pnpm.io/docker.

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
WORKDIR /workspace

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api apps/api
COPY packages/shared-types packages/shared-types
COPY packages/vigil packages/vigil
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @infusion/shared-types build
RUN pnpm --filter @infusion/vigil build
RUN pnpm --filter @infusion/api prisma:generate
RUN pnpm --filter @infusion/api build
RUN pnpm --filter @infusion/api deploy --prod /deploy/api

FROM node:20-alpine AS runtime
RUN apk add --no-cache tini
RUN addgroup -S infusion && adduser -S infusion -G infusion
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=infusion:infusion /deploy/api ./
USER infusion
EXPOSE 3000
# Migrations are NOT run automatically on boot — run
# `docker compose run --rm migrate` explicitly before starting/updating
# `api`, so a bad migration never blocks container startup silently and
# multiple replicas never race on `migrate deploy`.
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/main.js"]
