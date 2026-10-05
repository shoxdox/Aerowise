# One image for every Node service in the monorepo. docker-compose.yml picks the command.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/billing/package.json packages/billing/
COPY packages/compliance/package.json packages/compliance/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/observability/package.json packages/observability/
COPY packages/payments/package.json packages/payments/
COPY packages/quickbooks/package.json packages/quickbooks/
COPY packages/renewals/package.json packages/renewals/
COPY packages/reports/package.json packages/reports/
COPY packages/routing/package.json packages/routing/
COPY packages/sms/package.json packages/sms/
COPY packages/storage/package.json packages/storage/
COPY packages/tasks/package.json packages/tasks/
RUN pnpm install --frozen-lockfile

FROM deps AS app
COPY . .
# Rewrites are resolved at build time, so the API address inside Compose is baked in here.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @aerowise/web build
