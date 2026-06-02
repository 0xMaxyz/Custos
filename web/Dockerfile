# Custos web frontend (static build served by Caddy)
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --filter @custos/web... --frozen-lockfile=false
RUN pnpm --filter @custos/web build

FROM caddy:2-alpine AS runtime
COPY --from=build /app/web/dist /srv
EXPOSE 80
