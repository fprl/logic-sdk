import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    projects: [
      // The shop's rules, on PGlite in-process
      { test: { name: "node", include: ["test/*.test.ts"] } },
      // The Workers host inside workerd, with the real wrangler config. Hyperdrive points at PGlite (test/worker/setup.ts).
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { hyperdrives: { HYPERDRIVE: "postgres://postgres:postgres@127.0.0.1:5443/postgres" } },
          }),
        ],
        test: { name: "workers", include: ["test/worker/*.test.ts"], globalSetup: ["./test/worker/setup.ts"] },
      },
    ],
  },
});
