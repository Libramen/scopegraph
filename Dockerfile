# scopegraph server — build once, ship the catalog with it.
#
#   docker build -t scopegraph .
#   docker run --rm -p 3000:3000 --env-file .env scopegraph
#
# Catalog changes ship via git push + rebuild (the catalog is baked in at
# build time). Health check: GET /health.
# Base image pinned by digest (keep both FROM lines identical).
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# No dependency install scripts run inside the image build.
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY catalog ./catalog
# Payment records (buyer contact details) live in DATA_DIR. Create it owned by
# and private to the runtime user, so a Docker named volume mounted here is
# writable but not readable by other users. Platforms that mount volumes owned
# by root need them handed to uid/gid 1000 (the node user): docs/deploy.md.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
# Run as the non-root user the official node images ship with.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/cli/index.js", "serve"]
