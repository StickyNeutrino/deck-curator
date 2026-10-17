#!/usr/bin/env bash
# The test gate both deploy scripts run before anything is pushed or rolled
# out. Builds the Dockerfile's `ci` target — a throwaway image with dev
# dependencies and a Playwright Chromium — and runs the whole suite inside
# it: typecheck, unit/integration tests, then e2e against the production
# bundle. `docker run` exits with the container's exit code, so a failure
# stops the caller (they run under `set -e`) before the deploy image is
# built, pushed, or restarted on the cluster.
#
# The CI image is local-only (`deck-curator-ci`, no registry prefix) and is
# rebuilt each run. The browsers and their system libraries live in the
# FROM image of the ci stage (see the Dockerfile), so nothing in this repo
# ever triggers a browser re-download — a source edit or dependency bump
# just re-runs npm ci and the SPA build, and the SPA build is shared with
# the shipped image's build cache. The one big cost is the first run, which
# pulls the Playwright base image once (~2GB).
#
# `--init` reaps the browser processes Playwright spawns; `--ipc=host` gives
# Chromium the shared memory it needs beyond Docker's 64M default /dev/shm,
# under which it crashes for no apparent reason.
set -euo pipefail

CI_IMAGE=deck-curator-ci

docker build --target ci -t "$CI_IMAGE" .
docker run --rm --init --ipc=host "$CI_IMAGE"
