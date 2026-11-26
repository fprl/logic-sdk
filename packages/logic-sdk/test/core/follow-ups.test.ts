import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { databaseQueue, drizzleAdapter, jobsSchema, jobsTable } from "../../src/drizzle/pg.ts";
import { init, type FailureInfo } from "../../src/index.ts";

const pg = new PGlite();
await pg.exec(jobsSchema);
const db = drizzle({ client: pg });
const database = drizzleAdapter(db);
const { mutation, event, listener, createRegistry } = init<{ scope: { actor: string }; db: unknown }>();

const ordered = event({ payload: z.object({}) });
const paid = event({ payload: z.object({}) });
const order = mutation({ async handler(ctx) { ctx.emit(ordered, {}); } });
const pay = mutation({ async handler(ctx) { ctx.emit(paid, {}); } });

const ran: string[] = [];
/** What a second process's sweep would find while `receipt` runs. */
let crash: (() => Promise<unknown>) | undefined;
const charge = listener({
  event: () => ordered,
  async handler(ctx) {
    ran.push("charge");
    await ctx.run(pay);
  },
});
const stock = listener({ event: () => ordered, async handler() { ran.push("stock"); } });
const receipt = listener({
  event: () => paid,
  async handler() {
    ran.push("receipt");
    await crash?.();
  },
});

const failures: FailureInfo[] = [];
const modules = { shop: { ordered, paid, order, pay, charge, stock, receipt } };
const setup = (waitUntil?: (p: Promise<unknown>) => void) =>
  createRegistry({ modules, database: { adapter: database }, jobs: { adapter: databaseQueue(), scope: { load: (s) => s } }, onError: (_e, info) => failures.push(info), waitUntil });

beforeEach(async () => {
  await pg.exec("TRUNCATE logic_jobs, logic_cron_runs");
  ran.length = 0;
  failures.length = 0;
  crash = undefined;
});

test("a job is done before the jobs it queued run, after the jobs queued with it", async () => {
  let rows: string[] = [];
  crash = async () => void (rows = (await db.select().from(jobsTable)).map((r) => r.id.split("@")[0]!));
  await setup().as({ actor: "ana" }).run(order);
  expect(ran).toEqual(["charge", "stock", "receipt"]);
  expect(rows).toEqual(["shop.receipt"]); // charge's row is gone while receipt runs
});

test("the process dies in a job another one queued: only the one running is taken over", async () => {
  // every lease runs out, and another process sweeps
  crash = async () => {
    await pg.exec("UPDATE logic_jobs SET available_at = now() - interval '1 second'");
    await setup().jobs.sweep();
  };
  await setup().as({ actor: "ana" }).run(order);
  expect(ran).toEqual(["charge", "stock", "receipt"]); // charge didn't run again
  expect(failures.map((f) => f.source)).toEqual(["shop.receipt"]); // its one try never finished; charge's did
});

test("a sweep's jobs too, and with waitUntil", async () => {
  const held: Promise<unknown>[] = [];
  await setup((p) => void held.push(p)).as({ actor: "ana" }).run(order);
  await Promise.all(held);
  expect(held).toHaveLength(1); // the whole chain is one promise
  expect(ran).toEqual(["charge", "stock", "receipt"]);

  ran.length = 0;
  const quiet = createRegistry({ modules, database: { adapter: database }, jobs: { adapter: { ...databaseQueue(), deliver: async () => {} }, scope: { load: (s) => s } } });
  await quiet.as({ actor: "ana" }).run(order); // rows nobody ran
  await pg.exec("UPDATE logic_jobs SET available_at = now() - interval '1 second'");
  let rows: string[] = [];
  crash = async () => void (rows = (await db.select().from(jobsTable)).map((r) => r.id.split("@")[0]!));
  expect(await setup().jobs.sweep()).toMatchObject({ done: 2 });
  expect(ran).toEqual(["charge", "stock", "receipt"]);
  expect(rows).toEqual(["shop.receipt"]);
  expect(await db.select().from(jobsTable)).toEqual([]);
});
