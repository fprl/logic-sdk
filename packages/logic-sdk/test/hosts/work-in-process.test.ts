// work() in the web process: requests answer at once, and the loop starts their jobs right away, without waiting a poll.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect, test } from "bun:test";
import { z } from "zod";
import { databaseQueue, drizzleAdapter, jobsSchema } from "../../src/drizzle/pg.ts";
import { init } from "../../src/index.ts";
import { work } from "../../src/node.ts";

test("a request answers before its job, and work() in this process starts it at once", async () => {
  const pglite = new PGlite();
  await pglite.exec(jobsSchema);
  const { mutation, event, listener, createRegistry } = init<{ scope: { who: string }; db: any }>();
  const steps: string[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  let started!: () => void;
  const startedJob = new Promise<void>((resolve) => (started = resolve));
  const placed = event({ payload: z.object({ id: z.string() }) });
  const place = mutation({ input: placed.payload, async handler(ctx, input) { ctx.emit(placed, input); } });
  const receipt = listener({
    event: () => placed,
    async handler(_ctx, { id }) {
      steps.push(`job ${id} started`);
      started();
      await finished;
      steps.push(`job ${id} done`);
    },
  });
  const registry = createRegistry({
    modules: { shop: { placed, place, receipt } },
    database: { adapter: drizzleAdapter(drizzle({ client: pglite })) },
    jobs: { adapter: databaseQueue(), scope: { load: (s) => s } },
  });
  const stop = work(registry, { pollEvery: 60 }); // a poll a minute: only the wake can start it in time
  await new Promise((resolve) => setTimeout(resolve, 50)); // the slot has looked once and sleeps

  await registry.as({ who: "ana" }).run(place, { id: "o1" });
  steps.push("response");
  await Promise.race([startedJob, new Promise((_, reject) => setTimeout(() => reject(new Error("never woken")), 2000))]);
  finish();
  await stop();
  expect(steps).toEqual(["response", "job o1 started", "job o1 done"]);
  await pglite.close();
});
