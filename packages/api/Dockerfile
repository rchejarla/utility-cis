# Single image for the api package — runs as either the HTTP server or
# the BullMQ worker depending on the CMD override at deploy time.
#
#   API:    docker run … node dist/server.js
#   Worker: docker run … node dist/worker.js
#
# Migrations are intended to run as a one-shot init container with
# `node dist/scripts/migrate.js` (or `pnpm prisma migrate deploy`),
# never coupled to the api/worker startup paths.
#
# Base image is bookworm-slim (NOT alpine) because we need full ICU
# for IANA timezone math via Intl.DateTimeFormat. Alpine ships
# stripped ICU and silently returns wrong local times for non-UTC
# zones — caught the hard way during DST testing.

# ─── Build stage ────────────────────────────────────────────────────
FROM node:22-bookworm AS build
WORKDIR /repo

# pnpm via corepack — pinned to the version this monorepo uses.
RUN corepack enable

# Copy lockfile + manifests first so dependency layers cache across
# builds when only source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/

RUN pnpm install --frozen-lockfile --filter @utility-cis/shared --filter @utility-cis/api

# Copy source and build.
COPY packages/shared packages/shared
COPY packages/api packages/api

RUN pnpm --filter @utility-cis/shared build
RUN pnpm --filter @utility-cis/api build

# Prune dev dependencies for the runtime image. `--prod` leaves only
# what's needed at runtime in node_modules.
RUN pnpm --filter @utility-cis/shared --filter @utility-cis/api deploy --prod /deploy/api && \
    cp -r /deploy/api/node_modules /repo/packages/api/node_modules.prod

# ─── Runtime stage ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Copy compiled JS and prod-only node_modules.
COPY --from=build /repo/packages/api/dist ./dist
COPY --from=build /repo/packages/api/node_modules.prod ./node_modules
COPY --from=build /repo/packages/api/package.json ./package.json

# Copy the Prisma schema — needed at runtime for migrate scripts and
# for the generated client to find its WASM/engine binaries (already
# baked into node_modules but the schema location is hard-coded in
# Prisma's generator output).
COPY --from=build /repo/packages/shared/prisma ./prisma

# Run as non-root. Bookworm has a built-in `node` user (uid 1000).
USER node

# Expose ports — convention only; orchestrator decides what's reachable.
#   3001 — HTTP API
#   3002 — Worker health/metrics
EXPOSE 3001 3002

# CMD intentionally unset. Deployment manifests must specify either
# `node dist/server.js` (API) or `node dist/worker.js` (worker).
