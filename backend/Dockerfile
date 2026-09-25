# DataScout API. Build from this directory:
#
#   docker build -t datascout-api backend
#   docker run -p 4000:4000 -v datascout-data:/data \
#     -e JWT_SECRET=... -e CORS_ORIGIN=https://app.example.com datascout-api
#
# The SQLite file lives on the /data volume, so it survives container
# replacement. Everything else in the image is disposable.

# Node 24 matches development; node:sqlite needs >= 22.5 and no native build,
# so the slim image with no compiler is enough.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=4000 \
    DATABASE_URL=/data/datascout.db

WORKDIR /app

# Dependencies first so they cache across source-only changes. --omit=dev
# leaves out eslint and the test tooling; --ignore-scripts because nothing we
# depend on needs an install step, and it closes that supply-chain door.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

# Run unprivileged. /data is created and owned here so a fresh named volume
# inherits node:node and the app can write the database into it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 4000

# Uses the image's own node rather than curl, which the slim image lacks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Exec form so the process is PID 1 and gets SIGTERM for the graceful
# shutdown in server.js. No --env-file: config comes from `docker run -e`.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
