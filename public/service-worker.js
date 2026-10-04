// Deck Curator registers no service worker. This file exists so that a
// browser holding a stale registration for /service-worker.js on this origin
// (for example from another app that once ran on the same port) succeeds its
// update check and replaces that registration with this no-op — instead of
// retry-flooding the dev server with requests that 500 as "no route matches".
// No fetch handler: everything passes through untouched.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());
