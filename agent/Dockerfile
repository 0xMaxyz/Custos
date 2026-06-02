# Custos agent service
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/package.json
COPY agent/package.json agent/package.json
RUN pnpm install --filter @custos/agent... --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm --filter @custos/agent build

FROM base AS runtime
COPY --from=build /app .
EXPOSE 8080
CMD ["pnpm", "--filter", "@custos/agent", "start"]
