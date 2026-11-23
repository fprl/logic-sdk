import { z } from "zod";
import { expect, test } from "bun:test";
import { cloudflareQueue, handleQueue, handleScheduled, type QueueBatch } from "../src/cloudflare.ts";
import { init, type Job } from "../src/index.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string };
const { mutation, event, listener, cron, createRegistry } = init<{ scope: Scope; db: Store }>();

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
  const registry = createRegistry({ modules, database: memoryDatabase(), onError: (e) => reported.push((e as Error).message), jobs: { adapter: cloudflareQueue(queue), scope: { load: (saved) => saved } } });
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

test("cloudflareQueue splits sends under Cloudflare's limits: 100 messages, 256 KB, 128 KB each", async () => {
  const queue = fakeQueue();
  const registry = createRegistry({ modules, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(queue), scope: { load: (saved) => saved } } });
  await registry.as({ actor: "ana" }).run(emit, { what: Array.from({ length: 250 }, (_, i) => `e${i}`) });
  expect(queue.sent.map((b) => b.length)).toEqual([100, 100, 50]);

  const big = fakeQueue();
  const heavy = createRegistry({ modules, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(big), scope: { load: (saved) => saved } } });
  await heavy.as({ actor: "ana" }).run(emit, { what: Array.from({ length: 5 }, () => "x".repeat(100_000)) });
  expect(big.sent.map((b) => b.length)).toEqual([2, 2, 1]); // about 100 KB each
});

test("a job over 128 KB fails the send with a clear error, reported after commit", async () => {
  const reported: string[] = [];
  const registry = createRegistry({ modules, database: memoryDatabase(), onError: (e) => reported.push((e as Error).message), jobs: { adapter: cloudflareQueue(fakeQueue()), scope: { load: (saved) => saved } } });
  await registry.as({ actor: "ana" }).run(emit, { what: ["x".repeat(130_000)] });
  expect(reported).toEqual([expect.stringMatching(/bytes; Cloudflare Queues take 128000 per message. Keep payloads to ids/)]);
});

test("delay: sent with delaySeconds; over Cloudflare's 24 hours, createRegistry says to put an outbox in front", async () => {
  const later = listener({ event: () => happened, delay: 90, async handler() {} });
  const queue = fakeQueue();
  const registry = createRegistry({ modules: { x: { happened, emit, later } }, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(queue), scope: { load: (saved) => saved } } });
  await registry.as({ actor: "ana" }).run(emit, { what: ["a"] });
  expect(queue.sent[0]![0]!.delaySeconds).toBeOneOf([89, 90]);

  const tooLate = listener({ event: () => happened, delay: 90_000, async handler() {} });
  expect(() => createRegistry({ modules: { x: { happened, emit, tooLate } }, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(queue), scope: { load: (saved) => saved } } })).toThrow(
    /x\.tooLate waits 90000s; your jobs adapter holds jobs for at most 86400s\. Put an outbox in front/,
  );
});

test("handleScheduled ticks at the trigger's time and sweeps; a cron's run goes through the queue like any job", async () => {
  ran.length = 0;
  const queue = fakeQueue();
  const nightly = cron({ schedule: "0 3 * * *", run: () => emit, input: { what: ["nightly"] }, scope: { actor: "system" } });
  const registry = createRegistry({ modules: { x: { ...modules.x, nightly } }, database: memoryDatabase(), jobs: { adapter: cloudflareQueue(queue), scope: { load: (saved) => saved } } });
  await handleScheduled(registry, { scheduledTime: Date.parse("2026-11-23T03:00:00Z") });
  const [message] = queue.sent.flat();
  expect(message!.body).toMatchObject({ kind: "cron", id: "x.nightly@20261123T0300Z" });

  const { batch, acked } = batchOf([message!.body]);
  await handleQueue(registry, batch); // the consumer runs the cron, whose mutation emits, which sends again
  expect(acked).toEqual(["x.nightly@20261123T0300Z"]);
  expect(queue.sent.flat().map((m) => m.body.kind)).toEqual(["cron", "delivery"]);
});
