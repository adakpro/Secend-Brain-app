# syntax=docker/dockerfile:1.7
# Multi-stage build for the Node services (api, worker, agent-runner) and the web bundle.
# No secrets are passed as build args; dependencies install only from pnpm-lock.yaml.
ARG NODE_IMAGE=node:22.23.3-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/agent-runner/package.json apps/agent-runner/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY apps/agent-runner apps/agent-runner
COPY apps/web apps/web
COPY scripts/build-node.mjs scripts/build-node.mjs
RUN pnpm -r --filter './packages/*' --filter @sb/api --filter @sb/worker --filter @sb/agent-runner --filter @sb/web run typecheck \
 && pnpm --filter @sb/api --filter @sb/worker --filter @sb/agent-runner run build \
 && pnpm --filter @sb/web run build
# Production node_modules per service (externals only; app code is bundled).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @sb/api deploy --legacy --prod /out/api \
 && pnpm --filter @sb/worker deploy --legacy --prod /out/worker \
 && pnpm --filter @sb/agent-runner deploy --legacy --prod /out/agent-runner \
 && for a in api worker agent-runner; do rm -rf /out/$a/src /out/$a/test; cp -r apps/$a/dist /out/$a/dist; done

FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime-base AS api
USER root
RUN mkdir -p /data/vault /data/sources /data/backups /data/staging && chown -R node:node /data
USER node
COPY --chown=root:root --from=build /out/api /app
COPY --chown=root:root vendor/second-brain-os /app/vendor/second-brain-os
ENV SERVICE_NAME=api VENDOR_DIR=/app/vendor/second-brain-os VAULT_TEMPLATE_DIR=/app/vendor/second-brain-os/vault-template PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime-base AS worker
USER root
RUN mkdir -p /data/sources && chown -R node:node /data
USER node
COPY --chown=root:root --from=build /out/worker /app
COPY --chown=root:root vendor/second-brain-os /app/vendor/second-brain-os
ENV SERVICE_NAME=worker VENDOR_DIR=/app/vendor/second-brain-os
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime-base AS agent-runner
COPY --chown=root:root --from=build /out/agent-runner /app
ENV SERVICE_NAME=agent-runner PORT=8791 HOME=/tmp
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:8791/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM nginxinc/nginx-unprivileged:1.29.3-alpine AS web
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
