// One suite for every jobs adapter: the table in the docs ("What each one guarantees"), as tests. What only one adapter
// does (leases, receipts, signals) is tested next to it. adapters/jobs-adapters.test.ts runs it per adapter and database.
import { pgTable, text, type PgAsyncDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { drizzleAdapter, type DrizzleDb } from "../../src/drizzle/pg.ts";
import { init, type JobsAdapter, type FailureInfo, type Registry } from "../../src/index.ts";

export type Db = PgAsyncDatabase<PgQueryResultHKT>;
export type Scope = { actor: string };
const { mutation, event, listener, cron, createRegistry } = init<{ scope: Scope; db: DrizzleDb<Db> }>();

const orders = pgTable("adapter_orders", { tag: text("tag").notNull() });
const ran: string[] = [];
/** Tags whose listener fails, and how. */
const failing = new Map<string, "throw" | "deny">();

const placed = event({ payload: z.object({ tag: z.string() }) });
const place = mutation({
  input: z.object({ tag: z.string(), rollback: z.boolean().optional() }),
  async handler(ctx, { tag, rollback }) {
    await ctx.db.insert(orders).values({ tag });
    ctx.emit(placed, { tag });
    if (rollback) throw ctx.errors.reject("rolled_back");
  },
});
const email = listener({
  event: () => placed,
  attempts: 3,
  async handler(ctx, { tag }) {
    ran.push(`${tag}#${ctx.event.attempt}`);
    if (failing.get(tag) === "throw") throw new Error("smtp down");
    if (failing.get(tag) === "deny") throw ctx.errors.reject("no");
  },
});
const remind = mutation({
  input: z.object({ tag: z.string() }),
  async handler(_ctx, { tag }) {
    ran.push(tag);
  },
});
const plan = mutation({
  input: z.object({ tag: z.string(), delay: z.number().optional(), replace: z.boolean().optional() }),
  async handler(ctx, { tag, delay = 3600, replace }) {
    ctx.schedule(remind, { tag }, { delay, ...(replace ? { replace: true as const } : {}) });
  },
});
const tidy = mutation({
  async handler() {
    ran.push("tidy");
  },
});
const yearly = cron({
  schedule: "0 9 1 1 *", // only when a test ticks it
  scope: { actor: "system" },
  handler: (ctx) => ctx.run(tidy),
});
const modules = { shop: { placed, place, email, remind, plan, tidy, yearly } };
/** inProcess() runs each job once and refuses `attempts` above 1, so there its email listener tries once. */
const once = { shop: { ...modules.shop, email: listener({ event: () => placed, handler: email.handler as never }) } };

export interface Guarantees {
  /** A crash right after commit doesn't lose the job. */
  kept: boolean;
  /** Tries a job with `attempts: 3` gets. */
  tries: number;
  /** A job that failed for good is there to `retry(id)`. */
  keepsFailed: boolean;
  holds: boolean;
  replaces: boolean;
  /** Runs of a cron whose minute was ticked twice. */
  ticks: number;
  /** `failed()` lists what failed for good, and `forget(id)` deletes it. */
  lists: boolean;
  /** A listener's `key` runs its jobs one at a time, in order. */
  orders: boolean;
}

export interface Running {
  /** With the jobs tables and `adapter_orders (tag text)`. */
  db: Db;
  adapter: JobsAdapter;
  /** Time passes, and everything runs: delays, backoffs, redeliveries. */
  settle(registry: Registry<Scope>): Promise<void>;
  close(): Promise<void>;
}

export function jobsAdapterSuite(name: string, open: () => Promise<Running>, guarantees: Guarantees) {
  describe(name, () => {
    let running: Running;
    let registry: Registry<Scope, typeof modules>;
    let app: ReturnType<typeof registry.as>;
    const failures: FailureInfo[] = [];
    const build = (adapter: JobsAdapter) =>
      createRegistry({
        modules: (adapter.retries ? modules : once) as typeof modules,
        database: { adapter: drizzleAdapter(running.db) },
        jobs: { adapter, scope: { load: (saved) => saved } },
        onError: (_error, info) => failures.push(info),
      });
    const tag = () => crypto.randomUUID();
    const runsOf = (what: string) => ran.filter((run) => run.startsWith(what));
    const settle = () => running.settle(registry);

    beforeAll(async () => {
      running = await open();
      registry = build(running.adapter);
      app = registry.as({ actor: "ana" });
    });
    afterAll(() => running.close());

    test("a commit's job runs once; a rollback leaves none", async () => {
      const [ok, undone] = [tag(), tag()];
      await app.run(place, { tag: ok });
      await expect(app.run(place, { tag: undone, rollback: true })).rejects.toMatchObject({ kind: "rejected" });
      await settle();
      expect(runsOf(ok)).toEqual([`${ok}#1`]);
      expect(runsOf(undone)).toEqual([]);
    });

    test(guarantees.kept ? "a crash right after commit doesn't lose the job" : "a crash right after commit loses the job", async () => {
      const crashed = tag();
      const died = build({ ...running.adapter, deliver: async () => {} }); // the process died before it ran or sent
      await died.as({ actor: "ana" }).run(place, { tag: crashed });
      await settle();
      expect(runsOf(crashed)).toEqual(guarantees.kept ? [`${crashed}#1`] : []);
    });

    test(guarantees.tries > 1 ? "attempts above 1 are taken" : "attempts above 1 are refused at startup, not ignored", () => {
      const make = () => createRegistry({ modules, database: { adapter: drizzleAdapter(running.db) }, jobs: { adapter: running.adapter, scope: { load: (saved) => saved } } });
      if (guarantees.tries > 1) expect(make).not.toThrow();
      else expect(make).toThrow(/shop\.email has attempts: 3, but your jobs adapter, inProcess\(\), runs each job once/);
    });

    test("a throw gets its tries, then it's failed", async () => {
      const broken = tag();
      failing.set(broken, "throw");
      await app.run(place, { tag: broken });
      await settle();
      expect(runsOf(broken)).toEqual(Array.from({ length: guarantees.tries }, (_, i) => `${broken}#${i + 1}`));
      const outcomes = failures.filter((f) => f.job?.kind === "delivery" && JSON.stringify(f.job.envelope.payload).includes(broken)).map((f) => f.outcome);
      expect(outcomes).toEqual([...Array.from({ length: guarantees.tries - 1 }, () => "retry" as const), "failed"]);
    });

    test("a rule saying no is failed at once", async () => {
      const denied = tag();
      failing.set(denied, "deny");
      await app.run(place, { tag: denied });
      await settle();
      expect(runsOf(denied)).toEqual([`${denied}#1`]);
    });

    test(guarantees.keepsFailed ? "retry(id) runs a failed job again, as a first try" : "nothing keeps a failed job, so retry(id) refuses", async () => {
      const fixed = tag();
      failing.set(fixed, "deny");
      await app.run(place, { tag: fixed });
      await settle();
      const id = failures.findLast((f) => f.outcome === "failed")?.job?.id ?? "";
      if (!guarantees.keepsFailed) {
        await expect(registry.jobs.retry(id)).rejects.toThrow(/keeps no failed jobs/);
        return;
      }
      failing.delete(fixed);
      expect(await registry.jobs.retry(id)).toBe(true);
      await settle();
      expect(runsOf(fixed)).toEqual([`${fixed}#1`, `${fixed}#1`]);
    });

    test(guarantees.lists ? "failed() lists a job that failed for good, and forget(id) deletes it" : "failed() refuses: it can't list them", async () => {
      if (!guarantees.lists) {
        await expect(registry.jobs.failed()).rejects.toThrow(/can't list failed jobs/);
        return;
      }
      const doomed = tag();
      failing.set(doomed, "deny");
      await app.run(place, { tag: doomed });
      await settle();
      const { jobs } = await registry.jobs.failed({ source: "shop.email", scope: { actor: "ana" }, limit: 1000 });
      const mine = jobs.find((j) => j.job.kind === "delivery" && JSON.stringify(j.job.envelope.payload).includes(doomed));
      expect(mine).toMatchObject({ kind: "delivery", source: "shop.email", scope: { actor: "ana" }, error: expect.stringContaining("no") });
      expect(await registry.jobs.forget(mine!.id)).toBe(true);
      expect(await registry.jobs.forget(mine!.id)).toBe(false);
    });

    test("invoke() runs a cron now, through the adapter, beside its minute's own tick", async () => {
      const minute = new Date(Date.UTC(3000 + Math.floor(Math.random() * 6000), 0, 1, 9)); // a year of its own, as below
      const before = runsOf("tidy").length;
      expect(await registry.jobs.invoke(yearly, { at: minute })).toMatch(/^shop\.yearly@\d{8}T0900Z-[0-9a-f-]{36}$/);
      await registry.jobs.tick(minute);
      await settle();
      expect(runsOf("tidy").length - before).toBe(2);
    });

    test(guarantees.holds ? "a scheduled call waits, then runs" : "a scheduled call that waits is refused", async () => {
      const later = tag();
      if (!guarantees.holds) {
        await expect(app.run(plan, { tag: later })).rejects.toThrow(/can't hold jobs/);
        return;
      }
      await app.run(plan, { tag: later });
      expect(runsOf(later)).toEqual([]);
      await settle();
      expect(runsOf(later)).toEqual([later]);
    });

    test(guarantees.replaces ? "replace keeps only the newer call" : "replace is refused", async () => {
      const [same, other] = [tag(), tag()];
      if (!guarantees.replaces) {
        await expect(app.run(plan, { tag: same, replace: true })).rejects.toThrow(/can't replace/);
        return;
      }
      await app.run(plan, { tag: same, replace: true });
      await app.run(plan, { tag: same, replace: true, delay: 7200 }); // the dates moved: same function, same input
      await app.run(plan, { tag: other, replace: true }); // another input keeps its own
      await settle();
      expect(runsOf(same)).toEqual([same]);
      expect(runsOf(other)).toEqual([other]);
    });

    test(guarantees.orders ? "key: a key's jobs run one at a time, in order; a try backing off holds it" : "key is refused at startup", async () => {
      const key = tag();
      const keyed: string[] = [];
      const reply = listener({
        event: () => placed,
        key: (p) => p.tag.split(":")[0]!,
        attempts: guarantees.tries > 1 ? 2 : 1,
        async handler(ctx, { tag }) {
          if (!tag.startsWith(key)) return;
          keyed.push(`${tag.slice(key.length + 1)}#${ctx.event.attempt}`);
          if (tag.endsWith(":a") && ctx.event.attempt === 1 && guarantees.tries > 1) throw new Error("try again");
        },
      });
      const shop = { ...(running.adapter.retries ? modules : once).shop, reply };
      const make = () => createRegistry({ modules: { shop }, database: { adapter: drizzleAdapter(running.db) }, jobs: { adapter: running.adapter, scope: { load: (saved) => saved } }, onError: () => {} });
      if (!guarantees.orders) {
        expect(make).toThrow(/shop\.reply has a key, but your jobs adapter, .+, can't run jobs one at a time by key/);
        return;
      }
      const keyedRegistry = make();
      for (const job of ["a", "b", "c"]) await keyedRegistry.as({ actor: "ana" }).run(place, { tag: `${key}:${job}` });
      await running.settle(keyedRegistry as never);
      expect(keyed).toEqual(guarantees.tries > 1 ? ["a#1", "a#2", "b#1", "c#1"] : ["a#1", "b#1", "c#1"]);
    });

    test(`a cron's minute ticked twice runs ${guarantees.ticks === 1 ? "once" : "twice"}`, async () => {
      // a year of its own: the minute isn't one another test ticked
      const minute = new Date(Date.UTC(3000 + Math.floor(Math.random() * 6000), 0, 1, 9));
      const before = runsOf("tidy").length;
      await registry.jobs.tick(minute);
      await registry.jobs.tick(minute);
      await settle();
      expect(runsOf("tidy").length - before).toBe(guarantees.ticks);
    });
  });
}
