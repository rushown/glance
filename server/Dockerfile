# syntax=docker/dockerfile:1
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
WORKDIR /app
RUN addgroup -S glance && adduser -S glance -G glance && mkdir -p /data && chown glance:glance /data
COPY --from=build --chown=glance:glance /app/node_modules ./node_modules
COPY --from=build --chown=glance:glance /app/dist ./dist
COPY --chown=glance:glance package.json ./
USER glance
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/index.js"]
