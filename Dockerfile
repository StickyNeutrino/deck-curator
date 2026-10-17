# The manifest/lockfile are copied before the source in every stage, so the
# npm ci layers stay cached across source-only edits.
FROM node:26-alpine AS development-dependencies-env
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci

FROM node:26-alpine AS production-dependencies-env
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci --omit=dev

FROM node:26-alpine AS build-env
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci
COPY . /app/
# SPA build (ssr: false) — the whole app compiles into build/client
RUN npm run build

FROM node:26-alpine
COPY ./package.json /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
# The built single-page client, served statically with history fallback
COPY --from=build-env /app/build/client /app/build/client

WORKDIR /app
# Run as the image's `node` user (uid 1000) instead of root; the k8s
# manifests' runAsUser matches it. serve only reads build/client, so it
# needs no privileges and no writable directories.
USER node
# Invoke serve's binary directly: npm/npx want to write logs and caches
# under $HOME, which the read-only root filesystem (see the deployment
# manifests' securityContext) forbids. The listen port is pinned to the
# container port the service targets instead of relying on serve's default.
CMD ["./node_modules/.bin/serve", "./build/client", "--single", "--listen", "3000"]
