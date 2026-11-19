import { defineConfig } from "blume";
import { filesystem } from "blume/sources";

export default defineConfig({
  title: "Logic SDK",
  description:
    "Queries, mutations, actions and events for TypeScript apps. Transactions across modules, side effects after commit, and tests without mocks.",
  content: {
    // docs/ → /docs/*. The homepage is pages/index.astro.
    sources: [filesystem({ include: ["docs/**/*.{md,mdx}"], root: "." })],
  },
});
