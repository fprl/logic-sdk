// Reading env outside the modules is fine: the entry, routes, scripts, a lib. A t3 env.ts is one way, not required.
// It's flagged only because a module imports it (orders → lib/links → here).
export const env = { APP_URL: process.env.APP_URL ?? "http://localhost", MAX_ITEMS: Number(process.env.MAX_ITEMS ?? 20) };
