import { defineConfig } from "vitest/config";

// Real Postgres work (PGlite by default, Docker Postgres with DATABASE_URL), including a race: more than the 5s default.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], globalSetup: ["test/global-setup.ts"], testTimeout: 30_000 } });
