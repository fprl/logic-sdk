import type { JobsAdapter, SqlDatabase } from "logic-sdk";
import { databaseQueue, type DrizzleTx } from "logic-sdk/drizzle/pg";
import * as catalog from "./catalog";
import { createRegistry, type Db, type Mailer, type Settings } from "./logic";
import * as orders from "./orders";

/** The only file that imports every module. Each host (node.ts, worker.ts, app/) calls it with its own pieces. */
export const createShop = (options: {
  database: SqlDatabase<Db, DrizzleTx<Db>>;
  settings: Settings;
  mailer?: Mailer;
  /** Where this host's jobs go. Default: the database is the queue. */
  jobs?: JobsAdapter;
  waitUntil?: (promise: Promise<unknown>) => void;
}) =>
  createRegistry({
    modules: { catalog, orders },
    database: { adapter: options.database },
    services: { mailer: options.mailer ?? consoleMailer },
    config: options.settings,
    jobs: {
      adapter: options.jobs ?? databaseQueue(),
      // demo auth has no users table. In your app: `store` the ids, `load` the user with today's role
      scope: { load: (saved) => saved },
    },
    waitUntil: options.waitUntil,
  });

export type Shop = ReturnType<typeof createShop>;

/** Env in, settings out. Hosts read their env (process.env, Worker bindings) and pass it here; modules read ctx.config. */
export const settingsFrom = (env: { APP_URL?: string; MAX_ITEMS?: string }): Settings => ({
  app: { url: env.APP_URL ?? "http://localhost:3000" },
  orders: { maxItems: Number(env.MAX_ITEMS) || 10 },
});

// Swap for Resend, Postmark...
const consoleMailer: Mailer = {
  send: async (mail) => console.log("[mail]", mail),
};
