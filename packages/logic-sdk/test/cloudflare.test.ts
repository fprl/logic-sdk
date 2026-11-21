import { z } from "zod";
import { expect, test } from "bun:test";
import { cloudflareQueue, toQueueHandler, type QueueBatch } from "../src/cloudflare.ts";
import { init, type Job } from "../src/index.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string };
const { mutation, event, listener, createRegistry } = init<{ scope: Scope; db: Store }>();

const happened = event({ payload: z.object({ what: z.string() }) });
const emit = mutation({ input: z.object({ what: z.array(z.string()) }), async handler(ctx, { what }) {
  for (const w of what) ctx.emit(happened, { what: w });
} });
const ran: string[] = [];
const react = listener({ event: () => happened, async handler(ctx, { what }) {
  if (what === "throw") throw new Error("smtp down");
  if (what === "deny") throw ctx.errors.reject("nope");
  ran.push(`${what}#${ctx.event.attempt}`);
} });
const modules = { x: { happened, emit, react } };

/** A fake binding: what was sent, batch by batch. */
const fakeQueue = () => {
  const sent: { body: Job }[][] = [];
  return { sent, async sendBatch(messages: Iterable<{ body: Job }>) { sent.push([...messages]); } };
};
/** A fake consumer batch: which messages were acked and which retried. */
const batchOf = (jobs: Job[], attempts = 1) => {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch: QueueBatch = {
    messages: jobs.map((body) => ({ body, attempts, ack: () => acked.push(body.id), retry: () => retried.push(body.id) })),
  };
  return { batch, acked, retried };
};

test("cloudflareQueue sends after commit, and the consumer runs each job: ack, or retry when it throws", async () => {
  ran.length = 0;
  const queue = fakeQueue();
  const reported: string[] = [];
  const registry = createRegistry({ modules, database: memoryDatabase(), onError: (e) => reported.push((e as Error).message), jobs: { adapter: cloudflareQueue(queue) } });
  await registry.as({ actor: "ana" }).run(emit, { what: ["ok", "throw", "deny"] });
  expect(ran).toEqual([]); // nothing runs in the request
  const jobs = queue.sent.flat().map((m) => m.body);
  expect(jobs.map((j) => j.envelope.payload)).toEqual([{ what: "ok" }, { what: "throw" }, { what: "deny" }]);

  const { batch, acked, retried } = batchOf(jobs, 2);
  await toQueueHandler(registry)(batch);
  expect(ran).toEqual(["ok#2"]);
  expect(acked).toEqual([jobs[0]!.id, jobs[2]!.id]); // done, and failed for good
  expect(retried).toEqual([jobs[1]!.id]);
  expect(reported).toEqual(["smtp down", "x.nope"]);
});

test("cloudflareQueue splits sends under Cloudflare's limits: 100 messages, 256 KB", async () => {
  const queue = fakeQueue();
  const registry = createRegistry({ modules, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(queue) } });
  await registry.as({ actor: "ana" }).run(emit, { what: Array.from({ length: 250 }, (_, i) => `e${i}`) });
  expect(queue.sent.map((b) => b.length)).toEqual([100, 100, 50]);

  const big = fakeQueue();
  const heavy = createRegistry({ modules, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(big) } });
  await heavy.as({ actor: "ana" }).run(emit, { what: Array.from({ length: 5 }, () => "x".repeat(100_000)) });
  expect(big.sent.map((b) => b.length)).toEqual([2, 2, 1]); // about 100 KB each
});
