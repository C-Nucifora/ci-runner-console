# Build stage — needs the dev dependencies (tsc, vite) which never reach the runtime image.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
# ssh2's optional cpu-features native addon is a performance nicety, not a
# requirement, and building it would drag a toolchain into the image.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
# A stable build id keeps asset URLs reproducible for a given image tag.
ARG BUILD_ID
ENV BUILD_ID=${BUILD_ID}
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

# The audit log is the only path this process writes to.
RUN mkdir -p /var/lib/ci-runner-console \
 && chown -R node:node /var/lib/ci-runner-console /app

USER node
EXPOSE 8080

# Unauthenticated and free of anything sensitive, by design.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
