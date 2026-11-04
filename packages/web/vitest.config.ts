import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    /*
     * Sixty jsdom files in parallel, usually alongside a running dev
     * stack — the whole suite takes about a hundred seconds of wall
     * clock and far more CPU than the machine has. Vitest's 5-second
     * default then fails whichever test was unlucky enough to be
     * starved, and it is a different one each run: a test that passes
     * on its own and fails in the suite teaches nothing except not to
     * trust the suite.
     *
     * Fifteen seconds is still far short of any render these tests do,
     * so a genuine hang is still caught — just not by a stopwatch
     * measuring the machine's spare capacity.
     */
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
