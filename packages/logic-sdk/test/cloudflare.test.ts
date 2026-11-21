import { z } from "zod";
import { expect, test } from "bun:test";
import { cloudflareQueue, handleQueue, type QueueBatch } from "../src/cloudflare.ts";
import { init, type Job } from "../src/index.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string };
const { mutation, event, listener, createRegistry } = init<{ scope: Scope; db: Store }>();

const happened = event({ payload: z.object({ what: z.string() }) });
const emit = mutation({ input: z.object({ what: z.array(z.string()) }), async handler(ctx, { what }) {
  for (const w of what) ctx.emit(happened, { what: w });
} });
const ran: string[] = [];
const react = listener({ event: () => happened, attempts: 3, async handler(ctx, { what }) {
  if (what === "throw") throw new Error("smtp down");
  if (what === "deny") throw ctx.errors.reject("nope");
  ran.push(`${what}#${ctx.event.attempt}`);
} });
const modules = { x: { happened, emit, react } };

type Message = { body: Job; delaySeconds?: number };
/** A fake binding: what was sent, batch by batch. */
const fakeQueue = () => {
  const sent: Message[][] = [];
  return { sent, async sendBatch(messages: Iterable<Message>) { sent.push([...messages]); } };
};
/** A fake consumer batch: which messages were acked, and which retried after how long. */
const batchOf = (jobs: Job[], attempts = 1) => {
  const acked: string[] = [];
  const retried: [string, number | undefined][] = [];
  const batch: QueueBatch = {
    messages: jobs.map((body) => ({
      body,
      attempts,
      ack: () => acked.push(body.id),
      retry: (options) => retried.push([body.id, options?.delaySeconds]),
    })),
  };
  return { batch, acked, retried };
};

test("cloudflareQueue sends after commit; handleQueue runs each job: ack, or retry with a backoff while tries are left", async () => {
  ran.length = 0;
  const queue = fakeQueue();
  const reported: string[] = [];
  const registry = createRegistry({ modules, database: memoryDatabase(), onError: (e) => reported.push((e as Error).message), jobs: { adapter: cloudflareQueue(queue) } });
  await registry.as({ actor: "ana" }).run(emit, { what: ["ok", "throw", "deny"] });
  expect(ran).toEqual([]); // nothing runs in the request
  const jobs = queue.sent.flat().map((m) => m.body);
  expect(jobs.map((j) => j.envelope.payload)).toEqual([{ what: "ok" }, { what: "throw" }, { what: "deny" }]);

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

test("cloudflareQueue splits sends under Cloudflare's limits: 100 messages, 256 KB, 128 KB each", async () => {
  const queue = fakeQueue();
  const registry = createRegistry({ modules, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(queue) } });
  await registry.as({ actor: "ana" }).run(emit, { what: Array.from({ length: 250 }, (_, i) => `e${i}`) });
  expect(queue.sent.map((b) => b.length)).toEqual([100, 100, 50]);

  const big = fakeQueue();
  const heavy = createRegistry({ modules, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(big) } });
  await heavy.as({ actor: "ana" }).run(emit, { what: Array.from({ length: 5 }, () => "x".repeat(100_000)) });
  expect(big.sent.map((b) => b.length)).toEqual([2, 2, 1]); // about 100 KB each
});

test("a job over 128 KB fails the send with a clear error, reported after commit", async () => {
  const reported: string[] = [];
  const registry = createRegistry({ modules, database: memoryDatabase(), onError: (e) => reported.push((e as Error).message), jobs: { adapter: cloudflareQueue(fakeQueue()) } });
  await registry.as({ actor: "ana" }).run(emit, { what: ["x".repeat(130_000)] });
  expect(reported).toEqual([expect.stringMatching(/bytes; Cloudflare Queues take 128000 per message. Keep payloads to ids/)]);
});

test("delay: sent with delaySeconds; over Cloudflare's 24 hours, createRegistry says to put the outbox in front", async () => {
  const later = listener({ event: () => happened, delay: 90, async handler() {} });
  const queue = fakeQueue();
  const registry = createRegistry({ modules: { x: { happened, emit, later } }, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(queue) } });
  await registry.as({ actor: "ana" }).run(emit, { what: ["a"] });
  expect(queue.sent[0]![0]!.delaySeconds).toBeOneOf([89, 90]);

  const tooLate = listener({ event: () => happened, delay: 90_000, async handler() {} });
  expect(() => createRegistry({ modules: { x: { happened, emit, tooLate } }, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(queue) } })).toThrow(
    /x\.tooLate has a delay of 90000 seconds; Cloudflare Queues delay at most 86400.*outbox/,
  );
});
