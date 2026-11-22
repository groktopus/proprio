import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "bridge-template/src/**/*.test.ts"],
    environment: "node",
    // Keep the Workers SDK in Vite so unit-test mocks intercept its imports.
    server: { deps: { inline: ["@cloudflare/sandbox"] } },
  },
});
