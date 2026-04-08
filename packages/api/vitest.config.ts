import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
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
