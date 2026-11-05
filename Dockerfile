FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

# Copy pre-downloaded specs (downloaded outside Docker or via build script)
COPY f5-api/ ./f5-api/

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Build: generate index then compile TypeScript
RUN npx tsx scripts/build-index.ts
RUN npx tsc

# --- Runtime stage ---
FROM node:20-alpine

RUN addgroup -g 1001 -S appuser && adduser -S appuser -u 1001

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && chown -R appuser:appuser /app

COPY --from=builder --chown=appuser:appuser /app/dist/ ./dist/
COPY --from=builder --chown=appuser:appuser /app/data/ ./data/
COPY --from=builder --chown=appuser:appuser /app/f5-api/ ./f5-api/

ENV NODE_ENV=production

USER appuser

# Port 3000 used only when MCP_TRANSPORT=http
EXPOSE 3000

# HTTP transport: probes GET /healthz. stdio transport: no port, reports healthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "dist/src/healthcheck.js"]

ENTRYPOINT ["node", "dist/src/index.js"]
