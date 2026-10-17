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

# ---------- CI (docker build --target ci) ----------
# A throwaway test-runner image, never pushed: dev dependencies stay off the
# registry, and the shipped image above inherits nothing from this stage.
# scripts/ci.sh runs it as the gate both deploy scripts must pass before
# anything is pushed or rolled out.
#
# Base: the official Playwright image, which bakes the browsers AND their
# system libraries into the FROM layer. Browser downloads therefore depend
# on nothing in this repo — dependency bumps, source edits, and cache
# prunes never re-download Chromium; a new base is pulled only when the tag
# below changes. The tag must track the @playwright/test version in the
# lockfile (1.63.0 today); a mismatch leaves Playwright unable to find its
# browsers, so the first CMD step verifies the pair and heals any drift:
# a local no-op when they match, a chromium-only download when someone
# bumped one side without the other.
#
# The SPA is copied from build-env rather than rebuilt: the bundle is static
# output, and the deploy scripts' later full build of the shipped image then
# hits the build-env cache — the bundle compiles once per source change
# across both builds. `npm ci` is layered before the source copy like every
# stage above, so a source-only edit reuses it.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS ci
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci
COPY . /app/
COPY --from=build-env /app/build/client /app/build/client
# CI=1 arms Playwright's single retry and forbids reusing an already-running
# server; E2E_PROD serves build/client — the production bundle, where
# bundler-dependent bugs actually show (see playwright.config.ts). The chain
# runs fastest-failures-first: a type error or unit failure never pays for
# the e2e run.
ENV CI=1 E2E_PROD=1
CMD ["sh", "-c", "npx playwright install chromium && npm run typecheck && npm run test:run && npx playwright test"]
