# syntax=docker/dockerfile:1.7
# Optional native-claude service: the official Claude Code CLI, installed unmodified from the
# official npm package at a pinned version, plus a tiny PTY bridge. No product secrets inside.
ARG NODE_IMAGE=node:22.23.3-bookworm-slim

FROM ${NODE_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /svc
COPY apps/native-claude/package.json apps/native-claude/package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG CLAUDE_CODE_VERSION=2.1.291
ENV NODE_ENV=production DISABLE_AUTOUPDATER=1 HOME=/home/claude
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates git ripgrep && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version \
 && useradd --create-home --home-dir /home/claude --uid 1001 --shell /usr/sbin/nologin claude \
 && mkdir -p /workspace && chown claude:claude /workspace /home/claude
WORKDIR /svc
COPY --from=build /svc/node_modules ./node_modules
COPY apps/native-claude/package.json ./
COPY apps/native-claude/src ./src
USER claude
EXPOSE 8792
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:8792/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/main.mjs"]
