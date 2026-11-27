// A listener's and a cron's `failed`, and queues: declared once, refused when unknown, routed by the adapter.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry, type FailureInfo, type Job, type JobsAdapter } from "../../src/index.ts";
import { cloudflareQueue } from "../../src/cloudflare.ts";
import { action, cron, event, inline, listener, mutation, system, type Scope } from "../support/app.ts";
import { memoryDatabase } from "../support/memory-db.ts";

const happened = event({ payload: z.object({ orderId: z.string(), boom: z.boolean() }) });
const job = (payload: object, attempts = 2): Job => ({
  kind: "delivery",
  id: "x.send@e",
  listener: "x.send",
  envelope: { id: "e", name: "x.happened", payload, scope: { actor: "a", locale: "es" }, occurredAt: "", depth: 1 },
  attempts,
});

test("failed: runs once the last try fails, with the handler's ctx, the payload and the error; not on a retry", async () => {
  const seen: string[] = [];
  const flag = mutation({ input: z.object({ orderId: z.string() }), async handler(ctx, { orderId }) { seen.push(`flagged ${orderId} as ${ctx.scope.actor}`); } });
  const send = listener({
    event: () => happened,
    attempts: 2,
    async handler(_ctx, { boom }) {
      if (boom) throw new Error("mail down");
    },
    async failed(ctx, { orderId }, error) {
      seen.push(`failed ${orderId} on try ${ctx.event.attempt}: ${(error as Error).message}`);
      await ctx.run(flag, { orderId });
    },
  });
  const r = createRegistry<Scope>({ modules: { x: { happened, send, flag } }, database: { adapter: memoryDatabase() }, jobs: inline, onError: () => {} });

  await expect(r.jobs.run(job({ orderId: "o1", boom: true }), { attempt: 1 })).rejects.toThrow("mail down"); // a try left
  expect(seen).toEqual([]);
  expect(await r.jobs.run(job({ orderId: "o1", boom: true }), { attempt: 2 })).toEqual("failed");
  expect(seen).toEqual(["failed o1 on try 2: mail down", "flagged o1 as a"]);

  seen.length = 0;
  expect(await r.jobs.run(job({ orderId: "o2", boom: false }), { attempt: 3 })).toEqual("failed"); // its last try never finished
  expect(seen).toEqual(["failed o2 on try 3: [logic-sdk] x.send@e has used its 2 attempt(s): the last one never finished (crashed or outlived the lease), or its result wasn't recorded.", "flagged o2 as a"]);

  seen.length = 0;
  expect(await r.jobs.run(job({ orderId: 3 }))).toEqual("failed"); // a stale payload: nothing typed to pass it
  expect(seen).toEqual([]);
});

test("failed: a throw is reported, and the job stays failed", async () => {
  const reported: FailureInfo[] = [];
  const send = listener({
    event: () => happened,
    async handler() { throw new Error("mail down"); },
    async failed() { throw new Error("flag down"); },
  });
  const r = createRegistry<Scope>({ modules: { x: { happened, send } }, database: { adapter: memoryDatabase() }, jobs: inline, onError: (_e, info) => reported.push(info) });
  expect(await r.jobs.run(job({ orderId: "o1", boom: true }, 1))).toEqual("failed");
  expect(reported).toEqual([
    expect.objectContaining({ source: "x.send", outcome: "failed" }),
    expect.objectContaining({ source: "x.send (failed)", job: expect.objectContaining({ id: "x.send@e" }) }),
  ]);
});

test("failed on a cron: its own scope and run", async () => {
  const seen: string[] = [];
  const nightly = cron({
    schedule: "0 3 * * *",
    scope: system,
    async handler() { throw new Error("report down"); },
    async failed(ctx, error) { seen.push(`${ctx.cron.id} ${ctx.cron.scheduledAt} as ${ctx.scope.actor}: ${(error as Error).message}`); },
  });
  const r = createRegistry<Scope>({ modules: { x: { nightly } }, database: { adapter: memoryDatabase() }, jobs: inline, onError: () => {}, now: () => new Date("2026-07-01T03:00:10Z") });
  await r.jobs.tick();
  expect(seen).toEqual(["x.nightly 2026-07-01T03:00:00.000Z as system: report down"]);
});

const placed = event({ payload: z.object({ id: z.string() }) });
const place = mutation({ input: z.object({ id: z.string() }), async handler(ctx, input) { ctx.emit(placed, input); } });
const remind = action({ async handler() {} });
const later = mutation({ input: z.object({ queue: z.string() }), async handler(ctx, { queue }) { ctx.schedule(remind, undefined, { delay: 0, queue }); } });
const mail = listener({ event: () => placed, queue: "mail", async handler() {} });
const index = listener({ event: () => placed, async handler() {} });
const keeps = (queues: JobsAdapter["queues"], sent: Job[] = []): JobsAdapter => ({ queues, async deliver(jobs) { sent.push(...jobs); } });
const make = (adapter: JobsAdapter, queues?: string[], modules: object = { place, placed, mail, index, remind, later }) =>
  createRegistry<Scope>({ modules: { x: modules as never }, database: { adapter: memoryDatabase() }, jobs: { adapter, queues, scope: { load: (s) => s } } });

test("queues: a job carries its queue; default carries none", async () => {
  const sent: Job[] = [];
  await make(keeps(true, sent), ["mail"]).as({ actor: "a", locale: "es" }).run(place, { id: "o1" });
  expect(sent.map((j) => [j.kind === "delivery" && j.listener, j.queue])).toEqual([["x.mail", "mail"], ["x.index", undefined]]);
});

test("queues: an undeclared name is refused at createRegistry, at ctx.schedule, at a sweep and at a worker", async () => {
  expect(() => make(keeps(true))).toThrow(`[logic-sdk] x.mail has queue "mail", which jobs.queues doesn't declare (default).`);
  expect(() => make(keeps(true), ["default"])).toThrow(/takes names besides "default"/);
  expect(() => make(keeps(true), ["mail", "mail"])).toThrow(/lists a queue twice/);
  const r = make(keeps(true), ["mail"]);
  await expect(r.as({ actor: "a", locale: "es" }).run(later, { queue: "mial" })).rejects.toThrow(`ctx.schedule(x.remind) has queue "mial"`);
  await expect(r.jobs.sweep({ queues: ["mial"] })).rejects.toThrow(`jobs.sweep({ queues }) has queue "mial"`);
  expect(() => r.jobs.attach({ wake() {}, queues: ["mial"] })).toThrow(`A worker has queue "mial"`);
});

test("queues: an adapter that keeps one queue is refused, and one with a list needs every queue, default included", () => {
  expect(() => make({ async deliver() {} }, ["mail"])).toThrow(/jobs\.queues declares mail, but your jobs adapter keeps every job in one queue/);
  const binding = { sendBatch: async () => {} };
  expect(() => make(cloudflareQueue(binding), ["mail"])).toThrow(/cloudflareQueue\(queue\), keeps every job in one queue/);
  expect(() => make(cloudflareQueue({ mail: binding }), ["mail"])).toThrow(`has no queue for "default": give it one (it has mail)`);
  expect(() => make(cloudflareQueue({ default: binding, mail: binding }), ["mail"])).not.toThrow();
});

test("cloudflareQueue: each job goes to its queue's binding", async () => {
  const to: Record<string, string[]> = { default: [], mail: [] };
  const binding = (name: string) => ({ async sendBatch(messages: Iterable<{ body: Job }>) { for (const m of messages) to[name]!.push(m.body.id.split("@")[0]!); } });
  const adapter = cloudflareQueue({ default: binding("default"), mail: binding("mail") });
  await make(adapter, ["mail"]).as({ actor: "a", locale: "es" }).run(place, { id: "o1" });
  expect(to).toEqual({ default: ["x.index"], mail: ["x.mail"] });
});
