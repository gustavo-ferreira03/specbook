# syntax=docker/dockerfile:1
ARG BUILDKIT_SBOM_SCAN_STAGE=build

FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS base

ENV COREPACK_HOME=/opt/corepack \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install --global corepack@0.36.0 \
    && corepack enable pnpm \
    && mkdir -p "$COREPACK_HOME" \
    && chmod 755 "$COREPACK_HOME" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git procps tini util-linux xvfb x11vnc \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
RUN corepack install

FROM base AS build

RUN --mount=type=cache,id=pnpm-store-${TARGETARCH},target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY . .

RUN pnpm --filter backend build \
    && pnpm --filter frontend build

FROM base AS runtime

RUN --mount=type=cache,id=pnpm-store-${TARGETARCH},target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

COPY apps/backend/scripts ./apps/backend/scripts
RUN pnpm --filter backend browser:install:docker \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache \
    && mkdir -p /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/backend/drizzle ./apps/backend/drizzle
COPY --from=build /app/apps/frontend/.next ./apps/frontend/.next
COPY --from=build /app/apps/frontend/public ./apps/frontend/public
COPY --from=build /app/apps/frontend/next.config.ts ./apps/frontend/next.config.ts
COPY LICENSE /app/LICENSE
COPY --chmod=755 entrypoint.sh /app/entrypoint.sh
RUN rm -rf /app/apps/frontend/.next/cache \
    && mkdir -p /app/apps/backend/storage \
    && chown node:node /app/apps/backend/storage

ENV NODE_ENV=production \
    SPECBOOK_STORAGE_DIR=/app/apps/backend/storage \
    HOST=0.0.0.0

EXPOSE 4000 4001 1455 53692

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl --fail --silent "http://127.0.0.1:${PORT:-4000}/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/app/entrypoint.sh"]
