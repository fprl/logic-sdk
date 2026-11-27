// Crons: tick, a run as a job, invoke.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry, init, type Call, type FailureInfo, type Job } from "../../src/index.ts";
import { action, cron, cronSetup, event, inline, listener, mutation, signedIn, system, type Scope } from "../support/app.ts";
import { memoryDatabase, type Store } from "../support/memory-db.ts";

test("crons: tick runs what's due that minute, as the cron's scope, and what it runs checks its policy", async () => {
  const { registry, ran } = cronSetup({ onError: () => {} });
  expect(registry.definitions.crons.map((c) => c.id)).toEqual(["reports.weekly", "reports.friday", "reports.broken"]);
  expect(await registry.jobs.tick(new Date("2026-11-23T09:00:42Z"))).toEqual(["reports.weekly", "reports.broken"]); // a Monday, any second of 9:00
  expect(ran).toEqual(["weekly as system"]);
  expect(await registry.jobs.tick(new Date("2026-11-23T09:01:00Z"))).toEqual([]);
  expect(await registry.jobs.tick(new Date("2026-11-27T17:00:00Z"))).toEqual(["reports.friday"]); // 18:00 in Madrid
  await expect(registry.jobs.tick(new Date("garbage"))).rejects.toThrow(/tick needs a valid date/);
  expect(ran).toEqual(["weekly as system", "friday as system"]);

  // a scope the function's policy refuses: the run fails as `forbidden`, like any call
  const report = action({ authorize: signedIn, handler: async () => "sent" });
  const anonymous = cron({ schedule: "* * * * *", scope: { actor: null, locale: "en" }, handler: (ctx) => ctx.run(report) });
  const reported: FailureInfo[] = [];
  const r = createRegistry<Scope>({ modules: { x: { report, anonymous } }, onError: (_e, info) => reported.push(info) });
  await r.jobs.tick(new Date("2026-11-23T09:00:00Z"));
  expect(reported).toMatchObject([{ source: "x.anonymous", outcome: "failed" }]);
});

test("crons: a run is a job, `<cron id>@<minute>`, through the jobs adapter, with the cron's attempts", async () => {
  const sent: Job[] = [];
  const reported: FailureInfo[] = [];
  const { registry, ran } = cronSetup({ jobs: { adapter: { retries: true, async deliver(jobs) { sent.push(...jobs); } }, scope: { load: (_ctx, saved) => saved } }, onError: (_e, info) => reported.push(info) });
  await registry.jobs.tick(new Date("2026-11-23T09:00:00Z"));
  expect(sent).toEqual([
    { kind: "cron", id: "reports.weekly@20261123T0900Z", cron: "reports.weekly", scheduledAt: "2026-11-23T09:00:00.000Z", attempts: 1 },
    { kind: "cron", id: "reports.broken@20261123T0900Z", cron: "reports.broken", scheduledAt: "2026-11-23T09:00:00.000Z", attempts: 2 },
  ]);
  expect(ran).toEqual([]); // the adapter runs them, not tick
  const [, broken] = sent;
  await expect(registry.jobs.run(broken!, { attempt: 1 })).rejects.toThrow("smtp down"); // a try left
  expect(await registry.jobs.run(broken!, { attempt: 2 })).toBe("failed");
  expect(reported.at(-1)).toMatchObject({ source: "reports.broken", job: { id: "reports.broken@20261123T0900Z" }, outcome: "failed" });
  expect(await registry.jobs.run({ kind: "cron", id: "reports.gone@x", cron: "reports.gone", scheduledAt: "", attempts: 1 })).toBe("failed"); // renamed or removed
});

test("crons: the handler gets ctx.cron and runs its module's private functions; wrap sees the run as kind cron", async () => {
  const seen: unknown[] = [];
  const calls: Call[] = [];
  const tagged = init<{ scope: Scope; db: Store; meta: { tags?: string[] } }>();
  const tidy = tagged.mutation({ handler: async ({ db }) => void (db.rows.tidied ??= []).push("yes") }); // not exported: private
  const nightly = tagged.cron({
    schedule: "0 3 * * *",
    scope: system,
    attempts: 2,
    meta: { tags: ["ops"] },
    async handler(ctx) {
      seen.push(ctx.cron, ctx.scope.actor);
      await ctx.run(tidy);
    },
  });
  const db = memoryDatabase();
  const r = tagged.createRegistry({ modules: { ops: { nightly } }, database: { adapter: db }, jobs: inline, wrap: (call, next) => (calls.push(call), next()) });
  await r.jobs.run({ kind: "cron", id: "ops.nightly@20261124T0300Z", cron: "ops.nightly", scheduledAt: "2026-11-24T03:00:00.000Z", attempts: 2 }, { attempt: 2 });
  expect(seen).toEqual([{ id: "ops.nightly", scheduledAt: "2026-11-24T03:00:00.000Z", attempt: 2 }, "system"]);
  expect(db.store.rows.tidied).toEqual(["yes"]);
  expect(calls.map((c) => [c.kind, c.id, c.depth])).toEqual([["cron", "ops.nightly", 0], ["mutation", "ops.(private)", 1]]);
  expect(calls[0]).toMatchObject({ meta: { tags: ["ops"] }, scope: system, input: undefined });
  expect(calls.map((c) => c.job)).toEqual([{ id: "ops.nightly@20261124T0300Z", attempt: 2 }, undefined]); // the job's own call, not what it runs
});

test("crons: a schedule, time zone or attempts it can't use fails at startup", () => {
  const handler = async () => {};
  expect(() => cron({ schedule: "@daily", scope: system, handler })).toThrow(/needs five fields/);
  expect(() => cron({ schedule: "0 9 * * *", timezone: "Europe/Madird", scope: system, handler })).toThrow(RangeError);
  expect(() => cron({ schedule: "0 9 * * *", scope: system, attempts: 0, handler })).toThrow(/cron attempts must be a whole number/);
});

test("crons: invoke is a run now, its own job (`<cron>@<minute>-<uuid>`), through the jobs adapter; a failed hand-off throws", async () => {
  const sent: Job[] = [];
  const down = { now: false };
  const { registry, weekly } = cronSetup({
    now: () => new Date("2026-11-25T12:34:56Z"), // a Wednesday: weekly isn't due
    jobs: {
      adapter: {
        retries: true,
        async deliver(jobs) {
          if (down.now) throw new Error("queue unavailable");
          sent.push(...jobs);
        },
      },
      scope: { load: (_ctx, saved) => saved },
    },
    onError: () => {},
  });
  const id = await registry.jobs.invoke(weekly);
  expect(id).toMatch(/^reports\.weekly@20261125T1234Z-[0-9a-f-]{36}$/);
  await registry.jobs.invoke("reports.weekly", { at: new Date("2026-11-23T09:00:30Z") }); // by id, to redo a missed minute
  expect(sent).toEqual([
    { kind: "cron", id, cron: "reports.weekly", scheduledAt: "2026-11-25T12:34:00.000Z", attempts: 1 },
    { kind: "cron", id: expect.stringMatching(/^reports\.weekly@20261123T0900Z-/), cron: "reports.weekly", scheduledAt: "2026-11-23T09:00:00.000Z", attempts: 1 },
  ]);
  down.now = true;
  await expect(registry.jobs.invoke(weekly)).rejects.toThrow("queue unavailable"); // unlike a tick, which only reports it
  expect(await registry.jobs.tick(new Date("2026-11-23T09:00:00Z"))).toEqual(["reports.weekly", "reports.broken"]);
  await expect(registry.jobs.invoke("reports.nope")).rejects.toThrow(/no cron has that id \(reports\.weekly, reports\.friday, reports\.broken\)/);
  await expect(registry.jobs.invoke(cron({ schedule: "* * * * *", scope: system, handler: async () => {} }))).rejects.toThrow(/cron that isn't registered/);
  await expect(registry.jobs.invoke(weekly, { at: new Date("nope") })).rejects.toThrow(/needs a valid date/);
  await expect(registry.jobs.failed()).rejects.toThrow(/can't list failed jobs/); // this adapter keeps nothing
  await expect(registry.jobs.forget(id)).rejects.toThrow(/nothing to forget/);
});

test("a cron starts a chain: what its function emits is the first hop", async () => {
  const pinged = event({ payload: z.object({}) });
  const ping = mutation({ async handler(ctx) { ctx.emit(pinged, {}); } });
  const pong = listener({ event: () => pinged, async handler() {} });
  const nightly = cron({ schedule: "0 3 * * *", scope: { actor: null, locale: "en" }, handler: (ctx) => ctx.run(ping) });
  const depths: number[] = [];
  const r = createRegistry<Scope>({
    modules: { x: { pinged, ping, pong, nightly } },
    database: { adapter: memoryDatabase() },
    jobs: {
      adapter: {
        async deliver(jobs, runner) {
          for (const job of jobs) {
            if (job.kind === "delivery") depths.push(job.envelope.depth);
            else await runner.run(job);
          }
        },
      },
      scope: { load: (_ctx, saved) => saved },
    },
  });
  await r.jobs.tick(new Date("2026-11-23T03:00:00Z"));
  expect(depths).toEqual([1]);
});
