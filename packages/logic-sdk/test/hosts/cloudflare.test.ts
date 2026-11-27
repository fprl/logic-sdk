// handleQueue and handleScheduled: a Worker's queue and scheduled handlers, each one public call.
import { expect, test } from "bun:test";
import { cloudflareQueue, handleQueue, handleScheduled } from "../../src/cloudflare.ts";
import { batchOf, createRegistry, cron, emit, fakeQueue, modules, ran } from "../support/cloudflare.ts";
import { memoryDatabase } from "../support/memory-db.ts";

test("cloudflareQueue sends after commit; handleQueue runs each job: ack, or retry with a backoff while tries are left", async () => {
  ran.length = 0;
  const queue = fakeQueue();
  const reported: string[] = [];
  const registry = createRegistry({ modules, database: { adapter: memoryDatabase() }, onError: (e) => reported.push((e as Error).message), jobs: { adapter: cloudflareQueue(queue), scope: { load: (_ctx, saved) => saved } } });
  await registry.as({ actor: "ana" }).run(emit, { what: ["ok", "throw", "deny"] });
  expect(ran).toEqual([]); // nothing runs in the request
  const jobs = queue.sent.flat().map((m) => m.body);
  expect(jobs.map((j) => j.kind === "delivery" && j.envelope.payload)).toEqual([{ what: "ok" }, { what: "throw" }, { what: "deny" }]);

  const { batch, acked, retried } = batchOf(jobs, 2);
  await handleQueue(registry, batch);
  expect(ran).toEqual(["ok#2"]);
  expect(acked).toEqual([jobs[0]!.id, jobs[2]!.id]); // done, and failed for good
  expect(retried).toEqual([[jobs[1]!.id, 8]]); // e^2 seconds, not back to back
  expect(reported).toEqual(["smtp down", "x.nope"]);

  const last = batchOf([jobs[1]!], 3);
  await handleQueue(registry, last.batch);
  expect(last.acked).toEqual([jobs[1]!.id]); // its last try: failed for good, so Cloudflare doesn't retry it
});

test("handleScheduled ticks at the trigger's time and sweeps; a cron's run goes through the queue like any job", async () => {
  ran.length = 0;
  const queue = fakeQueue();
  const nightly = cron({ schedule: "0 3 * * *", scope: { actor: "system" }, handler: (ctx) => ctx.run(emit, { what: ["nightly"] }) });
  const registry = createRegistry({ modules: { x: { ...modules.x, nightly } }, database: { adapter: memoryDatabase() }, jobs: { adapter: cloudflareQueue(queue), scope: { load: (_ctx, saved) => saved } } });
  await handleScheduled(registry, { scheduledTime: Date.parse("2026-11-23T03:00:00Z") });
  const [message] = queue.sent.flat();
  expect(message!.body).toMatchObject({ kind: "cron", id: "x.nightly@20261123T0300Z" });

  const { batch, acked } = batchOf([message!.body]);
  await handleQueue(registry, batch); // the consumer runs the cron, whose mutation emits, which sends again
  expect(acked).toEqual(["x.nightly@20261123T0300Z"]);
  expect(queue.sent.flat().map((m) => m.body.kind)).toEqual(["cron", "delivery"]);
});
