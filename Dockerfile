FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy pre-downloaded specs (downloaded outside Docker or via build script)
COPY f5-api/ ./f5-api/

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Build: generate index then compile TypeScript
RUN npx tsx scripts/build-index.ts
RUN npx tsc

# --- Runtime stage ---
FROM node:20-alpine

WORKDIR /app

# Copy only what's needed at runtime
COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/data/ ./data/
COPY --from=builder /app/f5-api/ ./f5-api/

ENV NODE_ENV=production

# Expose port for HTTP transport mode (unused in stdio mode)
EXPOSE 3000

ENTRYPOINT ["node", "dist/src/index.js"]
