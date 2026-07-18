FROM node:22-trixie-slim

RUN npm install -g pnpm@10.30.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl procps python3 python3-pip python3-venv xvfb x11vnc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/robot \
    && /opt/robot/bin/pip install --no-cache-dir -r /tmp/requirements.txt

ENV PATH=/opt/robot/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
RUN pnpm install --frozen-lockfile

COPY apps/backend/scripts ./apps/backend/scripts
RUN pnpm --filter backend browser:install:docker
RUN rfbrowser init chromium

COPY . .

ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm --filter backend build \
    && pnpm --filter frontend build

RUN chmod +x /app/entrypoint.sh

ENV NODE_ENV=production
ENV SPECBOOK_STORAGE_DIR=/app/apps/backend/storage

EXPOSE 4000 4001

CMD ["/app/entrypoint.sh"]
