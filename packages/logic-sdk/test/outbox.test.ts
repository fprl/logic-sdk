import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text } from "drizzle-orm/pg-core";
import { beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { drizzleAdapter, outbox, outboxTable, type DrizzleTx } from "../src/drizzle.ts";
import { init, type Dispatcher } from "../src/index.ts";

// The real Postgres engine, in process. The DDL is what drizzle-kit generates from outboxTable.
const pg = new PGlite();
await pg.exec(`
  CREATE TABLE logic_outbox (
    id text PRIMARY KEY, delivery jsonb NOT NULL, status text DEFAULT 'pending' NOT NULL,
    attempts integer DEFAULT 0 NOT NULL, available_at timestamptz DEFAULT now() NOT NULL,
    last_error text, created_at timestamptz DEFAULT now() NOT NULL
  );
  CREATE INDEX logic_outbox_due ON logic_outbox (available_at) WHERE status = 'pending';
  CREATE TABLE items (name text PRIMARY KEY);
`);
const db = drizzle({ client: pg });
const items = pgTable("items", { name: text("name").primaryKey() });

type Scope = { actor: string };
const { mutation, event, listener, createRegistry } = init<{ scope: Scope; db: DrizzleTx<typeof db> }>();

const added = event({ payload: z.object({ name: z.string() }) });
const add = mutation({
  input: z.object({ name: z.string() }),
  async handler(ctx, { name }) {
    await ctx.db.insert(items).values({ name });
    ctx.emit(added, { name });
    if (name === "rolled-back") throw ctx.errors.reject("no");
  },
});
/** What the listener does next: run, throw, say no, or lose its lease mid-run. */
let next: "ok" | "throw" | "deny" | "lose-lease" = "ok";
const ran: string[] = [];
const react = listener({
  event: () => added,
  async handler(ctx, { name }) {
    ran.push(`${name}#${ctx.event.attempt}`);
    if (next === "throw") throw new Error("smtp down");
    if (next === "deny") throw ctx.errors.reject("nope");
    if (next === "lose-lease") await db.update(outboxTable).set({ attempts: sql`${outboxTable.attempts} + 1` }); // a sweep took it over
  },
});

const rows = () => db.select().from(outboxTable);
const makeDue = () => db.update(outboxTable).set({ availableAt: sql`now() - interval '1 second'` });
function setup(jobs: Dispatcher = outbox(db, { maxAttempts: 2 })) {
  const registry = createRegistry({ modules: { x: { added, add, react } }, database: drizzleAdapter(db), jobs: { adapter: jobs }, onError: () => {} });
  return { registry, app: registry.as({ actor: "ana" }) };
}

beforeEach(async () => {
  await pg.exec("TRUNCATE logic_outbox, items");
  next = "ok";
  ran.length = 0;
});

test("a committed event is delivered and its row deleted; a rolled-back one never existed", async () => {
  const { app } = setup();
  await app.run(add, { name: "desk" });
  expect(ran).toEqual(["desk#1"]);
  expect(await rows()).toEqual([]);
  await expect(app.run(add, { name: "rolled-back" })).rejects.toMatchObject({ kind: "rejected" });
  expect(await rows()).toEqual([]);
});

test("a failure keeps the row with a backoff and the error; a sweep after the backoff delivers it", async () => {
  const { app, registry } = setup(outbox(db, { maxAttempts: 3 }));
  next = "throw";
  await app.run(add, { name: "lamp" });
  const [row] = await rows();
  expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "smtp down" });
  expect(row!.availableAt.getTime()).toBeGreaterThan(Date.now()); // e^1 seconds from now
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 }); // not due yet
  next = "ok";
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["lamp#1", "lamp#2"]);
  expect(await rows()).toEqual([]);
});

test("out of attempts it's failed; retry puts it back in line, and only failed rows", async () => {
  const { app, registry } = setup();
  next = "throw";
  await app.run(add, { name: "chair" });
  const [pending] = await rows();
  expect(await registry.jobs.retry(pending!.id)).toBe(false); // pending: its runner or a sweep owns it, so retry leaves it alone
  expect(await rows()).toMatchObject([{ status: "pending", attempts: 1 }]);
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 1, discarded: 0, retrying: 0 });
  const [row] = await rows();
  expect(row).toMatchObject({ status: "failed", attempts: 2 });
  next = "ok";
  expect(await registry.jobs.retry(row!.id)).toBe(true);
  expect(await registry.jobs.retry("x.react@nope")).toBe(false);
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["chair#1", "chair#2", "chair#1"]);
});

test("a rule saying no is failed at once, no retries", async () => {
  const { app } = setup();
  next = "deny";
  await app.run(add, { name: "sofa" });
  expect(await rows()).toMatchObject([{ status: "failed", attempts: 1 }]);
});

test("a runner that crashed after commit: its lease expires and a sweep takes over", async () => {
  const { app, registry } = setup({ ...outbox(db), deliver: async () => {} }); // committed, then the process died
  await app.run(add, { name: "rug" });
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 }); // still leased
  await makeDue(); // the lease ran out
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["rug#2"]);
});

test("a slow runner can't undo a newer claim: completion writes are fenced on attempts", async () => {
  const { app } = setup();
  next = "lose-lease";
  await app.run(add, { name: "vase" });
  expect(await rows()).toMatchObject([{ status: "pending", attempts: 2 }]); // the newer runner still owns it
});

test("the row is the delivery: what was enqueued is what runs", async () => {
  const { app } = setup({ ...outbox(db), deliver: async () => {} });
  await app.run(add, { name: "mug" });
  const [row] = await db.select().from(outboxTable).where(eq(outboxTable.status, "pending"));
  expect(row!.delivery).toMatchObject({ id: row!.id, listener: "x.react", envelope: { name: "x.added", payload: { name: "mug" }, depth: 1 } });
});

test("a job whose scope can't be loaded is discarded: its row is deleted and the sweep counts it", async () => {
  let gone = false;
  const registry = createRegistry({
    modules: { x: { added, add, react } },
    database: drizzleAdapter(db),
    onError: () => {},
    jobs: { adapter: outbox(db), scope: { load: (s) => (gone ? null : s) } },
  });
  next = "throw";
  await registry.as({ actor: "ana" }).run(add, { name: "lamp" }); // first try fails: the row waits for a retry
  gone = true; // the account was offboarded meanwhile
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 1, retrying: 0 });
  expect(await rows()).toEqual([]);
  expect(ran).toEqual(["lamp#1"]);
});
