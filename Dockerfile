# Agentic Workbench — container image
# Runs the web server on Node 24+, which executes the TypeScript sources
# directly (native type stripping) and ships node:sqlite built in.

FROM node:24-slim

# git is required for the approval-gated git-commit feature (actions.ts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application sources and bundled examples.
COPY src ./src
COPY examples ./examples
COPY .env.example README.md ./

# App state lives here; declared as a volume so it survives container rebuilds.
# 'node' is the unprivileged user that ships with the base image.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
USER node

# Bind to all interfaces inside the container (default is 127.0.0.1, which is
# unreachable from the host). Override the port with WORKBENCH_PORT if needed.
ENV WORKBENCH_HOST=0.0.0.0 \
    WORKBENCH_PORT=3220 \
    WORKBENCH_DATA_DIR=/app/data

EXPOSE 3220

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKBENCH_PORT||3220)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.ts"]
