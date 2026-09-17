# Builds the Vite SPA and serves it (+ reverse-proxies /api/* to the api
# container) from a single Caddy container, which also terminates TLS via
# automatic HTTPS. Build context must be the monorepo root.
#
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://example.com/api -t infusion-web .

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
RUN pnpm --filter @infusion/web build

FROM caddy:2-alpine AS runtime
COPY infra/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/apps/web/dist /srv/web
EXPOSE 80 443
