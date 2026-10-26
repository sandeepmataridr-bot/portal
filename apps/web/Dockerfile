# Builds the Vite SPA (the staff app) and serves it, reverse-proxying /api/*
# to the api container, from a single Caddy container on plain HTTP :80.
# TLS ends in front of it (Cloudflare -> Tunnel -> Coolify's proxy; see
# infra/docker/Caddyfile). Build context must be the monorepo root.
#
#   docker build -f apps/web/Dockerfile --build-arg VITE_LANDING_URL=https://0dh.in -t portal-web .

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
WORKDIR /workspace

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web apps/web
COPY packages/shared-types packages/shared-types
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @infusion/shared-types build
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
# The public home page lives on its own at this address; the app's own root
# then opens the staff entry point (src/App.tsx). Empty keeps it in the app.
ARG VITE_LANDING_URL=
ENV VITE_LANDING_URL=${VITE_LANDING_URL}
RUN pnpm --filter @infusion/web build

FROM caddy:2-alpine AS runtime
COPY infra/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/apps/web/dist /srv/web
EXPOSE 80
