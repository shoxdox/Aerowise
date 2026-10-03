# One image for every Node service in the monorepo. docker-compose.yml picks the command.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile

FROM deps AS app
COPY . .
# Rewrites are resolved at build time, so the API address inside Compose is baked in here.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @aerowise/web build
