import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests run under vitest.integration.config.ts with
    // testcontainers — exclude them from the unit suite so `pnpm test`
    // doesn't try to spin up Docker on every dev run.
    exclude: ["src/__tests__/integration/worker-*.test.ts", "**/node_modules/**"],
    setupFiles: ["src/__tests__/vitest.setup.ts"],
    // Tell Vitest to look for modules in the monorepo root node_modules as well
    // This is needed for pnpm workspaces where hoisted deps live in the root
    server: {
      deps: {
        // Inline all packages to bypass Vite's ESM resolution issues with pnpm symlinks
        inline: [/^(?!.*vitest).*$/],
      },
    },
  },
});
