# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production AGENT_EVALUATION_HOST=0.0.0.0 AGENT_EVALUATION_INTERNAL_PORT=8200 \
    EVALUATION_DATA_DIR=/var/lib/agent-evaluation \
    EVALUATION_DATASET_PATH=/app/datasets/raglab-medical-sales-production-sample-v1.json
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY datasets ./datasets
RUN mkdir -p /var/lib/agent-evaluation/runs /var/lib/agent-evaluation/experiments /var/lib/agent-evaluation/pilots \
    /var/lib/agent-evaluation/workspaces /var/lib/agent-evaluation/stage-experiments \
    && chown -R node:node /var/lib/agent-evaluation
USER node
EXPOSE 8200
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:8200/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
