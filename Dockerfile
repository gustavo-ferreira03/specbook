# syntax=docker/dockerfile:1

# ---- base: runtime system packages shared by every stage --------------------
FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS base

# Node 25+ no longer bundles Corepack. Install it once and let it provide the
# pnpm version pinned in package.json's packageManager field.
ENV COREPACK_HOME=/opt/corepack
RUN npm install --global corepack@0.36.0 \
    && corepack enable pnpm \
    && mkdir -p "$COREPACK_HOME" \
    && chmod 755 "$COREPACK_HOME"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git procps tini util-linux xvfb x11vnc \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
RUN corepack install

# ---- build: full dependency tree, compiles both apps ------------------------
FROM base AS build

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY . .

RUN pnpm --filter backend build \
    && pnpm --filter frontend build

# ---- runtime: production dependencies, browsers, and build output -----------
FROM base AS runtime

# The store lives in a cache mount, so pnpm copies packages into node_modules
# and the image carries no second copy of them.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

# Playwright MCP (the agent's headed browser) and Playwright Test (Spec runs,
# headless) each pin their own Playwright release and therefore their own
# Chromium build, so one binary cannot safely serve both. Both install into
# PLAYWRIGHT_BROWSERS_PATH, so a revision they happen to share is downloaded once.
COPY apps/backend/scripts ./apps/backend/scripts
RUN pnpm --filter backend browser:install:docker \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

# Xvfb runs unprivileged and needs the shared X socket directory to exist.
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/backend/drizzle ./apps/backend/drizzle
COPY --from=build /app/apps/frontend/.next ./apps/frontend/.next
COPY --from=build /app/apps/frontend/public ./apps/frontend/public
COPY --from=build /app/apps/frontend/next.config.ts ./apps/frontend/next.config.ts
COPY --chmod=755 entrypoint.sh /app/entrypoint.sh
RUN rm -rf /app/apps/frontend/.next/cache \
    && mkdir -p /app/apps/backend/storage \
    && chown node:node /app/apps/backend/storage

ENV NODE_ENV=production
ENV SPECBOOK_STORAGE_DIR=/app/apps/backend/storage
ENV HOST=0.0.0.0

# 4000 direct API/Git, 4001 web UI with same-origin API and VNC, 1455 OpenAI Codex OAuth callback, 53692 Anthropic OAuth callback.
EXPOSE 4000 4001 1455 53692

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl --fail --silent "http://127.0.0.1:${PORT:-4000}/health" || exit 1

# The entrypoint starts as root only to fix ownership of an existing volume,
# then drops to the unprivileged `node` user before starting any service.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/app/entrypoint.sh"]
