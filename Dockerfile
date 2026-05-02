# syntax=docker/dockerfile:1.6

# ---- Stage 1: build ------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Install full deps (incl. dev) so `mastra build` can run.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ ./src/

# Produces the bundled output at .mastra/output/.
RUN npm run build

# ---- Stage 2: runtime ----------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Production-only deps — keeps the image small but still gives `mastra start`
# (which is in dependencies) and the LibSQL/Memory runtime libs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && \
    npm cache clean --force

# Copy build output and the runtime-needed knowledge files. Knowledge is
# read at runtime via cwd-relative path, so its location must match what
# searchKnowledge() expects.
COPY --from=build /app/.mastra ./.mastra
COPY --from=build /app/src/knowledge ./src/knowledge

# Persistent state dir for mastra.db; bind a named volume here so memory
# survives container restarts. The default MASTRA_DB_URL in compose points
# inside this dir.
RUN mkdir -p /app/data

EXPOSE 4111

# Default port; override with PORT env var if needed.
CMD ["npm", "start"]
