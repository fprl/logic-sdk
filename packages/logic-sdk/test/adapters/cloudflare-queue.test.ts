// cloudflareQueue: sends after commit, under Cloudflare's limits, with delaySeconds; failedJobs() beside it.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect, test } from "bun:test";
import { cloudflareQueue, handleQueue } from "../../src/cloudflare.ts";
import { databaseQueue, drizzleAdapter, failedJobs, jobsSchema } from "../../src/drizzle/pg.ts";
import { batchOf, createRegistry, emit, fakeQueue, happened, listener, modules } from "../support/cloudflare.ts";
import { memoryDatabase } from "../support/memory-db.ts";

test("cloudflareQueue splits sends under Cloudflare's limits: 100 messages, 256 KB, 128 KB each", async () => {
  const queue = fakeQueue();
  const registry = createRegistry({ modules, database: { adapter: memoryDatabase() }, jobs: { adapter: cloudflareQueue(queue), scope: { load: (_ctx, saved) => saved } } });
  await registry.as({ actor: "ana" }).run(emit, { what: Array.from({ length: 250 }, (_, i) => `e${i}`) });
  expect(queue.sent.map((b) => b.length)).toEqual([100, 100, 50]);

  const big = fakeQueue();
  const heavy = createRegistry({ modules, database: { adapter: memoryDatabase() }, jobs: { adapter: cloudflareQueue(big), scope: { load: (_ctx, saved) => saved } } });
  await heavy.as({ actor: "ana" }).run(emit, { what: Array.from({ length: 5 }, () => "x".repeat(100_000)) });
  expect(big.sent.map((b) => b.length)).toEqual([2, 2, 1]); // about 100 KB each
});

test("a job over 128 KB fails the send with a clear error, reported after commit", async () => {
  const reported: string[] = [];
  const registry = createRegistry({ modules, database: { adapter: memoryDatabase() }, onError: (e) => reported.push((e as Error).message), jobs: { adapter: cloudflareQueue(fakeQueue()), scope: { load: (_ctx, saved) => saved } } });
  await registry.as({ actor: "ana" }).run(emit, { what: ["x".repeat(130_000)] });
  expect(reported).toEqual([expect.stringMatching(/bytes; Cloudflare Queues take 128000 per message. Keep payloads to ids/)]);
});

test("delay: sent with delaySeconds; over Cloudflare's 24 hours, createRegistry says to put an outbox in front", async () => {
  const later = listener({ event: () => happened, delay: 90, async handler() {} });
  const queue = fakeQueue();
  const registry = createRegistry({ modules: { x: { happened, emit, later } }, database: { adapter: memoryDatabase() }, jobs: { adapter: cloudflareQueue(queue), scope: { load: (_ctx, saved) => saved } } });
  await registry.as({ actor: "ana" }).run(emit, { what: ["a"] });
  expect(queue.sent[0]![0]!.delaySeconds).toBeOneOf([89, 90]);

  const tooLate = listener({ event: () => happened, delay: 90_000, async handler() {} });
  expect(() => createRegistry({ modules: { x: { happened, emit, tooLate } }, database: { adapter: memoryDatabase() }, jobs: { adapter: cloudflareQueue(queue), scope: { load: (_ctx, saved) => saved } } })).toThrow(
    /x\.tooLate waits 90000s; your jobs adapter, cloudflareQueue\(queue\), holds jobs for at most 86400s\. Use one that holds them longer, or a jobs table in front of it/,
  );
});

test("cloudflareQueue alone keeps failed jobs in failedJobs(): listed, retried back to the queue, forgotten", async () => {
  const pg = new PGlite();
  await pg.exec(jobsSchema);
  const database = drizzleAdapter(drizzle({ client: pg }));
  const queue = fakeQueue();
  const store = failedJobs();
  const registry = createRegistry({
    modules,
    database: { adapter: database as never }, // the store keeps failed jobs in the registry's database
    onError: () => {},
    jobs: { adapter: cloudflareQueue(queue), failed: store, scope: { load: (_ctx, saved) => saved } },
  });
  await registry.as({ actor: "ana" }).run(emit, { what: ["throw", "deny"] });
  const jobs = queue.sent.flat().map((m) => m.body);
  const consumer = batchOf(jobs, 3); // their last try
  await handleQueue(registry, consumer.batch);
  expect(consumer.acked).toEqual([jobs[0]!.id, jobs[1]!.id]); // acked by the queue, kept by the store

  const { jobs: failed } = await registry.jobs.failed({ source: "x.react", scope: { actor: "ana" } });
  expect(failed.map((j) => j.id).sort()).toEqual(jobs.map((j) => j.id).sort());
  expect(failed.find((j) => j.id === jobs[0]!.id)?.error).toContain("smtp down");

  queue.sent.length = 0;
  expect(await registry.jobs.retry(jobs[0]!.id)).toBe(true); // out of the store, back to the queue
  expect(queue.sent.flat().map((m) => m.body.id)).toEqual([jobs[0]!.id]);
  expect(await registry.jobs.retry(jobs[0]!.id)).toBe(false);
  expect(await registry.jobs.forget(jobs[1]!.id)).toBe(true);
  expect((await registry.jobs.failed()).jobs).toEqual([]);

  // a store next to an adapter that keeps its own is refused
  expect(() => createRegistry({ modules, database: { adapter: database as never }, jobs: { adapter: databaseQueue(), failed: store, scope: { load: (_ctx, saved) => saved } } })).toThrow(
    /databaseQueue\(\), keeps failed jobs itself/,
  );
  await pg.close();
});
