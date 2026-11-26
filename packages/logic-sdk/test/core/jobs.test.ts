// Jobs: what an adapter is handed, registry.jobs.run's tries, jobs.scope.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry, init, inProcess, type Delivery, type FailureInfo, type Job, type JobsAdapter } from "../../src/index.ts";
import { deliveriesIn, event, inline, items, listener, mutation, retrying, setup, type Scope } from "../support/app.ts";
import { memoryDatabase, type Store } from "../support/memory-db.ts";

test("an adapter that can't take the jobs: each is reported with the job itself, and the caller still succeeds", async () => {
  const reported: FailureInfo[] = [];
  const { app } = setup({
    onError: (_e, info) => void reported.push(info),
    jobs: { adapter: { deliver: async () => { throw new Error("queue down"); } }, scope: { load: (saved) => saved } },
  });
  expect(await app.run(items.add, { name: "q" })).toBeDefined();
  expect(reported).toEqual([expect.objectContaining({ source: "(jobs adapter)", job: expect.objectContaining({ kind: "delivery", listener: "log.onAdded" }) })]);
});

test("custom jobs adapter: one delivery per listener, enqueued inside the transaction, delivered after", async () => {
  const seen: string[] = [];
  const { app } = setup({
    jobs: { adapter: {
      async enqueue(tx, jobs) { seen.push(`enqueue ${jobs.map((d) => d.kind === "delivery" && `${d.envelope.name}→${d.listener}`)} in tx=${tx !== undefined}`); },
      async deliver(deliveries, { run }) { seen.push("deliver"); for (const d of deliveries) seen.push(await run(d)); },
    }, scope: { load: (saved) => saved } },
  });
  await app.run(items.add, { name: "q" });
  expect(seen).toEqual(["enqueue items.added→log.onAdded in tx=true", "deliver", "done"]);
});

test("deliveries are JSON: what a queue carries comes back and runs", async () => {
  const deliveries: Job[] = [];
  const { app, registry } = setup({ jobs: { adapter: { async deliver(d) { deliveries.push(...d); } }, scope: { load: (saved) => saved } } });
  await app.run(items.add, { name: "j" });
  const d: Delivery = JSON.parse(JSON.stringify(deliveries[0]));
  expect(d).toMatchObject({ listener: "log.onAdded", envelope: { name: "items.added", depth: 1, scope: { locale: "es" }, payload: { name: "j" } } });
  expect(d).toMatchObject({ kind: "delivery", attempts: 1, id: `log.onAdded@${d.envelope.id}` });
  expect(await registry.jobs.run(d)).toEqual("done");
});

test("in-process stores nothing: sweep resolves zeros (one cron works with any adapter), retry throws", async () => {
  const { registry } = setup();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 });
  await expect(registry.jobs.retry("log.onAdded@e1")).rejects.toThrow(/inProcess\(\), keeps no failed jobs, so there's nothing to retry \(log\.onAdded@e1\)/);
});

test("registry.jobs.run: a throw retries while the job has tries left; rules and stale payloads fail at once", async () => {
  const happened = event({ payload: z.object({ kind: z.string() }) });
  let runs = 0;
  const react = listener({
    event: () => happened,
    attempts: 3,
    async handler(ctx, { kind }) {
      runs++;
      if (kind === "boom") throw new Error("exploded");
      if (kind === "gone") throw ctx.errors.notFound();
      if (kind === "taken") throw ctx.errors.conflict("taken");
    },
  });
  const once = listener({ event: () => happened, async handler() { throw new Error("once"); } });
  const reported: FailureInfo[] = [];
  const r = createRegistry<Scope>({ modules: { x: { happened, react, once } }, database: { adapter: memoryDatabase() }, jobs: inline, onError: (_e, info) => reported.push(info) });
  const job = (payload: object, listener = "x.react", attempts = 3) => ({ kind: "delivery" as const, id: `${listener}@e`, listener, envelope: { id: "e", name: "x.happened", payload, scope: { actor: "a", locale: "es" }, occurredAt: "", depth: 1 }, attempts });

  expect(await r.jobs.run(job({ kind: "fine" }))).toEqual("done");
  await expect(r.jobs.run(job({ kind: "boom" }), { attempt: 2 })).rejects.toThrow("exploded"); // tries left: the queue redelivers
  expect(reported.at(-1)).toMatchObject({ source: "x.react", job: { id: "x.react@e" }, attempt: 2, outcome: "retry" });
  expect(await r.jobs.run(job({ kind: "boom" }), { attempt: 3 })).toEqual("failed"); // the last try
  expect(reported.at(-1)).toMatchObject({ attempt: 3, outcome: "failed" });

  runs = 0;
  expect(await r.jobs.run(job({ kind: "fine" }), { attempt: 4 })).toEqual("failed"); // its last try crashed: not run again
  expect(runs).toBe(0);
  expect(await r.jobs.run(job({ kind: "x" }, "x.once", 1))).toEqual("failed"); // one try
  expect(await r.jobs.run(job({ kind: "boom" }, "x.react", 1))).toEqual("failed"); // the tries it was queued with, not today's code

  expect(await r.jobs.run(job({ kind: "gone" }))).toEqual("failed"); // a rule said no
  await expect(r.jobs.run(job({ kind: "taken" }))).rejects.toMatchObject({ kind: "conflict" }); // a lost race retries
  expect(await r.jobs.run(job({ nope: 1 }))).toEqual("failed"); // the payload no longer matches its schema
  runs = 0;
  const forOld = { ...job({ kind: "fine" }), envelope: { ...job({ kind: "fine" }).envelope, name: "x.renamed" } };
  expect(await r.jobs.run(forOld)).toEqual("failed"); // queued for an event this listener no longer listens to: never run
  expect(runs).toBe(0);
  expect(reported.at(-1)).toMatchObject({ source: "x.react", outcome: "failed" });
  await expect(r.jobs.run(job({ kind: "fine" }, "x.gone"))).rejects.toThrow(/x\.gone isn't a registered listener/); // code not here: a try like any other
  expect(reported.at(-1)).toMatchObject({ source: "x.gone", attempt: 1, outcome: "retry" });
  expect(await r.jobs.run(job({ kind: "fine" }, "x.gone"), { attempt: 3 })).toEqual("failed"); // the last try: kept for jobs.retry
  expect(reported.at(-1)).toMatchObject({ source: "x.gone", outcome: "failed" });
});

test("delay: the job says when it may run; an adapter that can't hold it (in-process) is refused at startup", async () => {
  const happened = event({ payload: z.object({}) });
  const doIt = mutation({ async handler(ctx) { ctx.emit(happened, {}); } });
  const ran: string[] = [];
  const later = listener({ event: () => happened, delay: 90, async handler() { ran.push("later"); } });
  const now = listener({ event: () => happened, async handler() { ran.push("now"); } });
  const jobs: Delivery[] = [];
  const make = (adapter?: JobsAdapter) =>
    createRegistry<Scope>({ modules: { x: { happened, doIt, later, now } }, database: { adapter: memoryDatabase() }, now: () => new Date("2026-07-01T10:00:00Z"), jobs: { adapter, scope: { load: (saved) => saved } } });
  await make({ holds: true, async deliver(d) { jobs.push(...deliveriesIn(d)); } }).as({ actor: "a", locale: "es" }).run(doIt);
  expect(jobs.map((j) => [j.listener, j.runAt])).toEqual([["x.later", "2026-07-01T10:01:30.000Z"], ["x.now", undefined]]);
  // Laravel's sync queue drops the delay; running a "tomorrow" job now would be wrong, so we refuse
  expect(() => make()).toThrow(/x\.later waits 90s, but your jobs adapter, inProcess\(\), can't hold jobs\. Use one that holds them/);
  expect(() => make({ holds: { max: 60 }, async deliver() {} })).toThrow(/holds jobs for at most 60s\. Use one that holds them longer, or a jobs table in front of it/);
  expect(ran).toEqual([]);
});

test("adapter hooks: connect sees the listeners and database at createRegistry; fail keeps what a consumer failed", async () => {
  const seen: string[] = [];
  const failed: string[] = [];
  const adapter: JobsAdapter = {
    connect: ({ listeners, database }) => void seen.push(...listeners.map((l) => l.id), database ? "db" : "no db"),
    deliver: async () => {},
    fail: async (job, error) => void failed.push(`${job.id}: ${(error as Error).message}`),
  };
  const { registry } = setup({ jobs: { adapter, scope: { load: (saved) => saved } }, onError: () => {} });
  expect(seen).toEqual(["log.onAdded", "db"]);
  const job = { kind: "delivery" as const, attempts: 1, id: "log.onAdded@e", listener: "log.onAdded", envelope: { id: "e", name: "items.added", payload: { name: "listener-fails" }, scope: { actor: "a", locale: "es" }, occurredAt: "", depth: 1 } };
  expect(await registry.jobs.run(job)).toEqual("failed");
  expect(failed).toEqual(["log.onAdded@e: listener exploded"]);
});

test("a job whose mutation swallowed a nested `reject` fails at once, as the `reject` would", async () => {
  const happened = event({ payload: z.object({}) });
  const refuses = mutation({ input: z.object({}), async handler({ errors }) { throw errors.reject("no"); } });
  const swallows = mutation({ input: z.object({}), async handler({ run }) { try { await run(refuses, {}); } catch {} } });
  const react = listener({ event: () => happened, attempts: 3, async handler({ run }) { await run(swallows, {}); } });
  const reported: FailureInfo[] = [];
  const r = createRegistry<Scope>({ modules: { x: { happened, refuses, swallows, react } }, database: { adapter: memoryDatabase() }, jobs: inline, onError: (_e, info) => reported.push(info) });
  const envelope = { id: "e", name: "x.happened", payload: {}, scope: { actor: "a", locale: "es" }, occurredAt: "", depth: 1 };
  expect(await r.jobs.run({ kind: "delivery", id: "x.react@e", listener: "x.react", envelope, attempts: 3 }, { attempt: 1 })).toEqual("failed");
  expect(reported.at(-1)).toMatchObject({ source: "x.react", attempt: 1, outcome: "failed" });
});

test("jobs.scope: store picks what's saved, load rebuilds it at run time, null discards", async () => {
  const m = init<{ scope: Scope; db: Store }>();
  const happened = m.event({ payload: z.object({ n: z.number() }) });
  const doIt = m.mutation({ input: z.object({ n: z.number() }), async handler(ctx, { n }) { ctx.emit(happened, { n }); } });
  const seen: Scope[] = [];
  const react = m.listener({ event: () => happened, async handler({ scope }) { seen.push(scope); } });
  const stored: object[] = [];
  const outcomes: string[] = [];
  const reported: string[] = [];
  const r = m.createRegistry({
    modules: { x: { happened, doIt, react } },
    database: { adapter: memoryDatabase() },
    onError: (e) => reported.push((e as Error).message),
    jobs: {
      adapter: { async deliver(d, { run }) { for (const j of deliveriesIn(d)) { stored.push(j.envelope.scope); outcomes.push(await run(j)); } } },
      scope: {
        store: (s) => ({ actor: s.actor }), // the locale isn't saved
        load: async (saved) => (saved.actor === "gone" ? null : { actor: saved.actor, locale: "fresh" }),
      },
    },
  });
  await r.as({ actor: "ana", locale: "es" }).run(doIt, { n: 1 });
  await r.as({ actor: "gone", locale: "es" }).run(doIt, { n: 2 });
  expect(stored).toEqual([{ actor: "ana" }, { actor: "gone" }]);
  expect(seen).toEqual([{ actor: "ana", locale: "fresh" }]);
  expect(outcomes).toEqual(["done", "discarded"]);
  expect(reported).toEqual([expect.stringMatching(/jobs\.scope\.load returned null for x\.react@.+, so it was discarded/)]);
});

test("jobs.scope: what store returns must be plain JSON; a load that throws is retried", async () => {
  const happened = event({ payload: z.object({}) });
  const doIt = mutation({ async handler(ctx) { ctx.emit(happened, {}); } });
  const react = listener({ event: () => happened, attempts: 2, async handler() {} });
  const make = (scope: object) => createRegistry<Scope>({ modules: { x: { happened, doIt, react } }, database: { adapter: memoryDatabase() }, onError: () => {}, jobs: { adapter: retrying, scope } });
  await expect(make({ store: () => ({ at: new Date() }), load: () => null }).as({ actor: "a", locale: "es" }).run(doIt)).rejects.toThrow(/scope emitting x\.happened isn't plain data at at: a Date/);
  const flaky = make({ load: async () => { throw new Error("db down"); } });
  const job = { kind: "delivery" as const, attempts: 2, id: "x.react@e", listener: "x.react", envelope: { id: "e", name: "x.happened", payload: {}, scope: {}, occurredAt: "", depth: 1 } };
  await expect(flaky.jobs.run(job)).rejects.toThrow("db down");
});

test("a job of a kind this version doesn't know uses its attempts, then the adapter keeps it", async () => {
  const kept: string[] = [];
  const { registry } = setup({ onError: () => {}, jobs: { adapter: { deliver: async () => {}, fail: async (_job, e) => void kept.push((e as Error).message) }, scope: { load: (saved) => saved } } });
  const job = { kind: "nope", id: "x", attempts: 2, listener: "log.onAdded", envelope: { id: "e", name: "items.added", payload: { name: "a" }, scope: {}, occurredAt: "", depth: 1 } };
  await expect(registry.jobs.run(job as never)).rejects.toThrow(/which this version can't run/);
  expect(await registry.jobs.run(job as never, { attempt: 2 })).toEqual("failed");
  expect(kept).toEqual([expect.stringMatching(/job x has kind "nope", which this version can't run/)]);
});

test("jobs.scope.load failing counts as a try: at the default of one, the job fails", async () => {
  const happened = event({ payload: z.object({}) });
  const react = listener({ event: () => happened, async handler() {} });
  const r = createRegistry<Scope>({ modules: { x: { happened, react } }, onError: () => {}, jobs: { scope: { load: async () => { throw new Error("db down"); } } } });
  const job = { kind: "delivery" as const, attempts: 1, id: "x.react@e", listener: "x.react", envelope: { id: "e", name: "x.happened", payload: {}, scope: {}, occurredAt: "", depth: 1 } };
  expect(await r.jobs.run(job)).toEqual("failed");
});

test("jobs.scope: any adapter but inProcess() keeps jobs to run later, so it needs load: a job runs with today's roles", () => {
  const later = { holds: true as const, async deliver() {} };
  const forwards = { async deliver() {} }; // sends to a queue: it keeps them too
  // @ts-expect-error the types ask for scope; createRegistry still checks, for JS and a scope without load
  expect(() => createRegistry<Scope>({ modules: {}, jobs: { adapter: later } })).toThrow(/keeps jobs to run later, so set jobs\.scope\.load/);
  // @ts-expect-error the same, for an adapter that only forwards
  expect(() => createRegistry<Scope>({ modules: {}, jobs: { adapter: forwards } })).toThrow(/jobs\.scope\.load/);
  expect(() => createRegistry<Scope>({ modules: {}, jobs: { adapter: later, scope: { load: (saved) => saved } } })).not.toThrow(); // keeping it as it was is a choice you write down
  expect(() => createRegistry<Scope>({ modules: {}, jobs: { adapter: inProcess() } })).not.toThrow(); // runs now, in this process: nothing waits
});

test("jobs.scope: store without load throws; load returning undefined retries instead of discarding", async () => {
  expect(() => createRegistry({ modules: {}, jobs: { scope: { store: (s: object) => s } as never } })).toThrow("jobs.scope has store but no load");
  const happened = event({ payload: z.object({}) });
  const react = listener({ event: () => happened, attempts: 2, async handler() {} });
  const r = createRegistry<Scope>({ modules: { x: { happened, react } }, onError: () => {}, jobs: { adapter: retrying, scope: { load: (() => undefined) as never } } });
  const job = { kind: "delivery" as const, attempts: 2, id: "x.react@e", listener: "x.react", envelope: { id: "e", name: "x.happened", payload: {}, scope: {}, occurredAt: "", depth: 1 } };
  await expect(r.jobs.run(job)).rejects.toThrow(/load returned undefined for x\.react@e\. Return the scope, or null to discard/);
});
