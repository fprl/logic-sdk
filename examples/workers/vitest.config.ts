import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd with the real wrangler config. Hyperdrive points at an in-process
// Postgres (PGlite, started in test/global-setup.ts), so `vitest` needs no Docker.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { hyperdrives: { HYPERDRIVE: "postgres://postgres:postgres@127.0.0.1:5441/postgres" } },
    }),
  ],
  test: { globalSetup: ["./test/global-setup.ts"] },
});
