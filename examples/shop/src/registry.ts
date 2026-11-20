import { drizzleAdapter } from "logic-sdk/drizzle";
import * as catalog from "./catalog";
import { createRegistry, type Db, type Mailer, type Settings } from "./logic";
import * as orders from "./orders";

/** The only file that imports every module. Each host (node.ts, worker.ts, app/) calls it with its own pieces. */
export const createShop = (options: {
  db: Db;
  settings: Settings;
  mailer?: Mailer;
  waitUntil?: (promise: Promise<unknown>) => void;
}) =>
  createRegistry({
    modules: { catalog, orders },
    database: drizzleAdapter(options.db),
    services: { mailer: options.mailer ?? consoleMailer },
    config: options.settings,
    waitUntil: options.waitUntil,
  });

export type Shop = ReturnType<typeof createShop>;

/** Env in, settings out. Hosts read their env (process.env, Worker bindings) and pass it here; modules read ctx.config. */
// The index signature lets process.env and Worker bindings both fit
export const settingsFrom = (env: { APP_URL?: string; MAX_ITEMS?: string; [name: string]: unknown }): Settings => ({
  app: { url: env.APP_URL ?? "http://localhost:3000" },
  orders: { maxItems: Number(env.MAX_ITEMS) || 10 },
});

// Swap for Resend, Postmark...
const consoleMailer: Mailer = {
  send: async (mail) => console.log("[mail]", mail),
};
