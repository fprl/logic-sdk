// A process of its own for sqlite.test.ts, run with Node: several share one file.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { databaseQueue, drizzleAdapter, type DrizzleDb } from "../src/drizzle/sqlite.ts";
import { init, type Schema } from "../src/index.ts";

const [mode, file = "", startAt = "0"] = process.argv.slice(2);
// no zod: plain Node runs this file
const Added: Schema<{ id: string }, { id: string }> = { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value: value as { id: string } }) } };
while (Date.now() < Number(startAt)); // every process starts in the same millisecond

const open = () => drizzle(file);
const database = drizzleAdapter(open);
const { mutation, event, listener, createRegistry } = init<{ scope: object; db: DrizzleDb<ReturnType<typeof open>> }>();
const added = event({ payload: Added });
const add = mutation({
  async handler(ctx) {
    const id = crypto.randomUUID();
    ctx.db.run(sql`insert into items (name) values (${id})`);
    ctx.emit(added, { id });
    if (mode === "die") {
      console.log("holding the lock, not committed");
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  },
});
const record = mutation({
  input: Added,
  async handler(ctx, { id }) {
    ctx.db.run(sql`insert into runs (id) values (${id})`);
  },
});
const onAdded = listener({ event: () => added, async handler(ctx, payload) { await ctx.run(record, payload); } });
const queue = databaseQueue(database);
const registry = createRegistry({
  modules: { x: { added, add, record, onAdded } },
  database,
  // `enqueue` commits jobs and never runs them, as if each process died after its commit
  jobs: { adapter: mode === "enqueue" ? { ...queue, deliver: async () => {} } : queue, scope: { load: (saved) => saved } },
});

if (mode === "sweep") console.log((await registry.jobs.sweep({ limit: 1000 })).done);
else if (mode === "die") await registry.as({}).run(add);
else await Promise.all(Array.from({ length: 25 }, () => registry.as({}).run(add)));
