import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), !process.env.VITEST && reactRouter(), tsconfigPaths()],
  build: {
    outDir: "./build/client",
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  publicDir: "public",
  optimizeDeps: {
    // Pre-bundle the lazily imported heavy deps so dev doesn't 504 on first
    // dynamic import (outdated-dep reload churn).
    include: ["leaflet", "isomorphic-git", "@isomorphic-git/lightning-fs"],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
    server: {
      deps: {
        inline: [/react-router/],
      },
    },
    include: ["test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
  },
  server: {
    // Bind to all interfaces so the dev server is reachable through
    // container port publishing / VS Code port forwarding.
    host: true,
  },
} as any);
