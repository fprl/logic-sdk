// A tiny two-module app (separate consts, like real module files), and the setups the core tests share.
import { z } from "zod";
import { createRegistry, init, type Delivery, type Job, type Runner } from "../../src/index.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

/** Like inProcess(), one try per run here, but it says it retries: for tests of what `attempts` do, which inProcess() refuses. */
export const retrying = { retries: true as const, async deliver(jobs: Job[], { run }: Runner) { for (const job of jobs) await run({ ...job, attempts: 1 }); } };
export const inline = { adapter: retrying, scope: { load: (saved: any) => saved } };

export const deliveriesIn = (jobs: Job[]) => jobs.filter((j): j is Delivery => j.kind === "delivery");

export type Scope = { actor: string | null; locale: string };
export const { query, mutation, action, event, listener, cron } = init<{ scope: Scope; db: Store; services: { log: string[] } }>();
export const anyone = () => true;
export const signedIn = (s: Scope): s is Scope & { actor: string } => s.actor !== null;

// ── the two modules ─────────────────────────────────────────────────────────
export const added = event({ payload: z.object({ name: z.string() }) });

export const list = query({
  input: z.object({}).optional(),
  authorize: anyone,
  output: z.array(z.string()),
  handler: async ({ db }) => (db.rows.items ?? []).map((r) => r.name as string),
});
export const add = mutation({
  input: z.object({ name: z.string().min(1) }),
  authorize: signedIn,
  output: z.object({ name: z.string() }),
  async handler({ db, emit, errors, scope }, { name }) {
    const actor: string = scope.actor; // narrowed by the policy
    if (name === "boom") throw errors.reject("boom");
    void actor;
    (db.rows.items ??= []).push({ name });
    emit(added, { name });
    return { name };
  },
});
export const addTwo = mutation({
  input: z.object({ a: z.string(), b: z.string() }),
  async handler({ run }, { a, b }) {
    await run(add, { name: a });
    try { await run(add, { name: b }); } catch { /* caught, but the transaction is doomed */ }
    return "done";
  },
});
export const typed = mutation({
  input: z.object({ n: z.number() }),
  output: z.object({ doubled: z.number().max(10) }),
  handler: async (_, { n }) => ({ doubled: n * 2 }),
});
export const locale = query({ handler: async ({ scope }) => scope.locale });
export const whoami = query({
  handler: async ({ scope, run }) => ({
    outer: scope.locale,
    inner: await run(locale, undefined, { scope: { ...scope, locale: "en" } }),
    nested: await run(locale),
  }),
});
export const greet = action({
  input: z.object({ name: z.string() }),
  async handler({ run, services }, { name }) {
    services.log.push(`greet ${name}`);
    return run(add, { name });
  },
});
export const items = { added, list, add, addTwo, typed, locale, whoami, greet };

export const onAdded = listener({ event: () => added, handler: async ({ services, event, scope }, { name }) => {
  if (name === "listener-fails") throw new Error("listener exploded");
  services.log.push(`added ${name} (${event.name}, ${scope.locale})`);
} });
export const log = { onAdded };

export function setup(extra: Partial<Parameters<typeof createRegistry>[0]> = {}) {
  const db = memoryDatabase();
  const services = { log: [] as string[] };
  const registry = createRegistry<Scope>({ modules: { items, log }, database: { adapter: db }, services, ...extra });
  const app = registry.as({ actor: "ana", locale: "es" });
  return { db, services, registry, app };
}

// ── for the regressions from the code review ───────────────────────────────
export const stamped = event({ payload: z.object({ at: z.string().transform((s) => new Date(s)) }) });
export const reg = {
  stamped,
  badEmitThenThrow: mutation({
    input: z.object({}),
    async handler({ emit, errors }) {
      emit(stamped, { at: 42 as unknown as string });
      throw errors.reject("boom");
    },
  }),
  stamp: mutation({
    input: z.object({ at: z.string() }),
    async handler({ emit }, { at }) { emit(stamped, { at }); },
  }),
  throwsUndefined: mutation({
    input: z.object({}),
    async handler({ db }) { (db.rows.t ??= []).push("inner"); throw undefined; },
  }),
  swallowsUndefined: mutation({
    input: z.object({}),
    async handler({ db, run }) {
      (db.rows.t ??= []).push("outer");
      try { await run(reg.throwsUndefined, {}); } catch {}
      return "ok";
    },
  }),
  swallowsBadInput: mutation({
    input: z.object({}),
    async handler({ db, run }) {
      (db.rows.t ??= []).push("outer");
      // @ts-expect-error deliberately invalid
      try { await run(add, { name: 1 }); } catch {}
      return "ok";
    },
  }),
} as const;
/** What the `onStamped` listener got. */
export const stampedSeen: { at: unknown }[] = [];
export const regListeners = { onStamped: listener({ event: () => stamped, handler: async (_, payload) => { stampedSeen.push(payload); } }) };

export function regSetup(extra: Partial<Parameters<typeof createRegistry>[0]> = {}) {
  const db = memoryDatabase();
  const d = createRegistry<Scope>({ modules: { items, log, reg, regListeners }, database: { adapter: db }, services: { log: [] }, ...extra });
  return { db, app: d.as({ actor: "a", locale: "es" }), d };
}

// ── crons ────────────────────────────────────────────────────────────────────
export const system: Scope = { actor: "system", locale: "en" };

export function cronSetup(extra: Partial<Parameters<typeof createRegistry>[0]> = {}) {
  const ran: string[] = [];
  const report = action({
    input: z.object({ kind: z.string() }),
    authorize: signedIn,
    async handler(ctx, { kind }) {
      if (kind === "broken") throw new Error("smtp down");
      ran.push(`${kind} as ${ctx.scope.actor}`);
    },
  });
  const weekly = cron({ schedule: "0 9 * * 1", scope: system, handler: (ctx) => ctx.run(report, { kind: "weekly" }) });
  const friday = cron({ schedule: "0 18 * * 5", timezone: "Europe/Madrid", scope: system, handler: (ctx) => ctx.run(report, { kind: "friday" }) });
  const broken = cron({ schedule: "0 9 * * 1", scope: system, attempts: 2, handler: (ctx) => ctx.run(report, { kind: "broken" }) });
  const registry = createRegistry<Scope>({ modules: { reports: { report, weekly, friday, broken } }, database: { adapter: memoryDatabase() }, jobs: inline, ...extra });
  return { registry, ran, weekly, broken };
}

// ── ctx.schedule ─────────────────────────────────────────────────────────────
export function scheduleSetup(extra: Partial<Parameters<typeof createRegistry>[0]> = {}) {
  const reminded: string[] = [];
  const remind = action({
    input: z.object({ who: z.string() }),
    async handler(ctx, { who }) {
      if (who === "nobody") throw ctx.errors.notFound();
      reminded.push(`${who} as ${ctx.scope.actor} in ${ctx.scope.locale}`);
    },
  });
  const book = mutation({
    input: z.object({ who: z.string(), fail: z.boolean().optional(), at: z.string().optional() }),
    async handler(ctx, { who, fail, at }) {
      ctx.schedule(remind, { who }, at ? { at: new Date(at) } : { delay: 3600 });
      if (fail) throw ctx.errors.reject("nope");
    },
  });
  const sent: Job[] = [];
  const registry = createRegistry<Scope>({
    modules: { bookings: { remind, book } },
    database: { adapter: memoryDatabase() },
    now: () => new Date("2026-07-01T10:00:00Z"),
    jobs: { adapter: { holds: true, async deliver(jobs) { sent.push(...jobs); } }, scope: { load: (saved) => saved } },
    ...extra,
  });
  return { registry, book, reminded, sent, app: registry.as({ actor: "ana", locale: "es" }) };
}
