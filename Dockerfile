# syntax=docker/dockerfile:1
#
# sparktop image.
#
# Multi-arch: arm64 is the primary target because that is what a DGX Spark runs,
# but amd64 works identically since collection is agentless — the container only
# needs an SSH client path to the nodes, not to be one of them.

# ---- Stage 1: dependencies -------------------------------------------------
FROM oven/bun:1-alpine AS deps
WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/tui/package.json packages/tui/

# Full install (including dev deps) so the web bundle can be built.
RUN bun install --frozen-lockfile

# ---- Stage 2: build the web UI ---------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY packages/ packages/
RUN bun run build:web

# ---- Stage 3: runtime ------------------------------------------------------
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# openssh-client is not used for transport (ssh2 speaks the protocol directly),
# but ssh-keygen is handy for generating a key inside the container.
RUN apk add --no-cache openssh-client tini && \
    addgroup -g 10001 sparktop && \
    adduser -D -u 10001 -G sparktop sparktop

ENV NODE_ENV=production \
    SPARKTOP_PORT=5757 \
    SPARKTOP_HOST=0.0.0.0 \
    SPARKTOP_CONFIG=/config/nodes.json \
    SPARKTOP_WEB_ROOT=/app/packages/web/dist

# Runtime needs only production dependencies.
#
# Every workspace member's manifest is copied, including the web package whose
# source is not shipped: bun resolves the workspace against the lockfile, and
# omitting a member makes the lockfile look stale, which --frozen-lockfile
# (correctly) refuses to work around.
COPY package.json bun.lock* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/tui/package.json packages/tui/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile --production --ignore-scripts && \
    rm -rf /root/.bun/install/cache

COPY --from=build /app/packages/core/src packages/core/src
COPY --from=build /app/packages/server/src packages/server/src
COPY --from=build /app/packages/tui/src packages/tui/src
COPY --from=build /app/packages/web/dist packages/web/dist
COPY tsconfig.json ./

RUN mkdir -p /config && chown -R sparktop:sparktop /config /app

USER sparktop
EXPOSE 5757

# Tini reaps zombies so SIGTERM shuts the collector down cleanly.
ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.SPARKTOP_PORT||5757)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "packages/server/src/index.ts"]
