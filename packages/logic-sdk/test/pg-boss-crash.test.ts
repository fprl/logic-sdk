import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect, setDefaultTimeout, test } from "bun:test";
import { fromPglite, PgBoss } from "pg-boss";
import { z } from "zod";
import { drizzleAdapter } from "../src/drizzle/pg.ts";
import { init, type FailureInfo } from "../src/index.ts";
import { pgBoss, queueName, work, type PgBossMeta } from "../src/pg-boss.ts";

setDefaultTimeout(30_000);

test("a worker that dies on a job's last try: pg-boss expires it, and the failure still reaches onError", async () => {
  const pg = new PGlite();
  // a supervisor that looks every second (60 by default)
  const boss = new PgBoss({ db: fromPglite(pg), backend: "pglite", superviseIntervalSeconds: 1, monitorIntervalSeconds: 1 });
  boss.on("error", console.error);
  await boss.start();

  const { mutation, event, listener, createRegistry } = init<{ scope: object; db: unknown; meta: PgBossMeta }>();
  const added = event({ payload: z.object({}) });
  const add = mutation({ async handler(ctx) { ctx.emit(added, {}); } });
  let ran = 0;
  const react = listener({
    event: () => added,
    meta: { pgBoss: { queue: { expireInSeconds: 1, retryDelayMax: 1 }, worker: { pollingIntervalSeconds: 0.5 } } },
    async handler() { ran++; },
  });
  const failures: FailureInfo[] = [];
  const registry = createRegistry({
    modules: { x: { added, add, react } },
    database: drizzleAdapter(drizzle({ client: pg })),
    jobs: { adapter: pgBoss(boss), scope: { load: (s) => s } },
    onError: (_e, info) => failures.push(info),
  });
  const queue = queueName("x.react");
  await boss.createQueue(queue, { expireInSeconds: 1, retryDelayMax: 1, retryBackoff: true });
  await registry.as({}).run(add);

  expect(await boss.fetch(queue)).toHaveLength(1); // its only try, taken by a worker that's never heard from again
  await work(registry, boss); // a healthy one
  const state = async () => (await boss.findJobs(queue))[0]?.state;
  while ((await state()) !== "failed") await new Promise((r) => setTimeout(r, 100));

  expect(ran).toBe(0); // not run again: its one try was used
  expect(failures).toMatchObject([{ source: "x.react", attempt: 2, outcome: "failed" }]);
  await boss.stop({ graceful: false });
});
