import {
  replaceKeyOf,
  type Caller,
  type DeepPartial,
  type CallJob,
  type Delivery,
  type Envelope,
  type Fn,
  type FnIn,
  type FnOut,
  type Job,
  type JobOutcome,
  type JobsAdapter,
  type Listener,
  type Registry,
} from "./index.ts";
import { deliveryOf } from "./jobs.ts";
import { INTERNAL } from "./types.ts";

export interface TestOptions<Cf = unknown> {
  /** Replace services (e.g. `{ mailer: memoryMailer() }`). */
  services?: object;
  /** Override parts of `config` (e.g. `{ orders: { maxItems: 1 } }`). Merged over the registry's, section by section. */
  config?: DeepPartial<Cf>;
  /** Freeze time. */
  now?: Date | string | (() => Date);
  /**
   * `"inline"` (default): listeners run right after each mutation, inside the test. `"manual"`: jobs wait in
   * `t.jobs.queued` until you `drain()` them, to test one module without the others reacting. Like Oban's
   * `testing: :inline | :manual`. Either way, what waits (a listener's `delay`, `ctx.schedule`) waits for `drain()`, and
   * your app's adapter (a database queue, an outbox, Cloudflare) is never used.
   */
  jobs?: "inline" | "manual";
}

/** The jobs of the current test, like `registry.jobs` in production. */
export interface TestJobs<S> {
  /** Listener jobs waiting: every one in `jobs: "manual"`, and the delayed ones in either mode. */
  readonly queued: readonly Delivery[];
  /** What `ctx.schedule` asked for, waiting for `drain()`. */
  readonly scheduled: readonly CallJob[];
  /**
   * Run what's due at the test's now (or `until`), and what that queues, until nothing due is left. Throws a failure.
   * Like Rails' `perform_enqueued_jobs(at:)` and Oban's `drain_queue(with_scheduled:)`.
   */
  drain(options?: { until?: Date | string }): Promise<void>;
  /** Run one listener by hand, as if its event had been emitted as `scope`. Throws its failure, like `drain()`. */
  perform<O>(listener: Listener<O>, payload: O, options: { scope: S; attempt?: number }): Promise<JobOutcome>;
  /** Run the crons due in `at`'s minute (default: the test's now), here and now. Resolves their ids; throws a failure. */
  tick(at?: Date | string): Promise<string[]>;
}

export interface TestRegistry<S extends object, Mods extends Record<string, object>, Cf> {
  /** Open the test's transaction: `beforeEach(() => t.begin())`. */
  begin(): Promise<void>;
  /** Roll it back: `afterEach(() => t.rollback())`. */
  rollback(): Promise<void>;
  /** Bind who is calling, like `registry.as(...)`. A listener that fails makes `run` throw, so a test can't pass over it. */
  as(scope: S): Caller<S>;
  /** Replace a function's implementation for this test. Matched by identity, so `run(availability.hold, …)` hits the stub. */
  stub<F extends Fn>(fn: F, impl: (ctx: unknown, input: FnIn<F>) => Promise<FnOut<F>>): void;
  /** Every event emitted (and committed) in this test, in order. */
  readonly events: readonly Envelope[];
  /** The test transaction itself: read rows to assert on them. */
  readonly db: any;
  /** The registry bound to this test's transaction, for adapters: `toFetchHandler(t.registry, …)`. */
  readonly registry: Registry<S, Mods, Cf>;
  readonly jobs: TestJobs<S>;
}

/** One test, between `begin` and `rollback`. */
interface Open<S extends object, Mods extends Record<string, object>, Cf> {
  registry: Registry<S, Mods, Cf>;
  db: unknown;
  events: Envelope[];
  stubs: Map<Fn, (ctx: never, input: never) => Promise<unknown>>;
  queued: Delivery[];
  scheduled: CallJob[];
  /** Job failures (listeners, crons, scheduled calls) during the current call. */
  failures: unknown[];
  close(): Promise<void>;
}

class Rollback extends Error {}

/**
 * The test's jobs adapter. What waits (a delayed listener, `ctx.schedule`) is held for `drain()`, and in `"manual"` so
 * is everything else; the rest runs now. It holds and replaces what your app's adapter does, so a test fails where
 * production would.
 */
const testJobs = (mode: TestOptions["jobs"], app: JobsAdapter | undefined, queued: Delivery[], scheduled: CallJob[]): JobsAdapter => ({
  holds: app?.holds,
  replaces: app?.replaces,
  async deliver(jobs, runner) {
    for (const job of jobs) {
      const key = replaceKeyOf(job);
      if (key) {
        const waiting = scheduled.findIndex((c) => replaceKeyOf(c) === key);
        if (waiting >= 0) scheduled.splice(waiting, 1);
      }
      const waits = job.runAt !== undefined || (mode === "manual" && job.kind !== "cron");
      if (!waits) await runner.run({ ...job, attempts: 1 }); // one try, like inProcess(): reported, so the test sees it
      else if (job.kind === "call") scheduled.push(job);
      else if (job.kind === "delivery") queued.push(job);
    }
  },
});

/** Removes the jobs that are due from `list` and returns them. */
function takeDue<T extends Job>(list: T[], cutoff: number): T[] {
  const due = (job: T) => !job.runAt || Date.parse(job.runAt) <= cutoff;
  const ready = list.filter(due);
  list.splice(0, list.length, ...list.filter((job) => !due(job)));
  return ready;
}

/**
 * Run each test inside a transaction that's rolled back, set up once with hooks:
 *
 * ```ts
 * const t = createTestRegistry(registry);
 * beforeEach(() => t.begin());
 * afterEach(() => t.rollback());
 * ```
 *
 * Every top-level mutation inside becomes a savepoint, so a failing mutation rolls back just its own writes, like it
 * would in production. Tests that share `t` run one at a time (one connection, nested savepoints).
 */
export function createTestRegistry<S extends object, Mods extends Record<string, object>, Cf>(
  registry: Registry<S, Mods, Cf>,
  options: TestOptions<Cf> = {},
): TestRegistry<S, Mods, Cf> {
  const { options: registryOptions } = registry[INTERNAL];
  const fixed = options.now;
  const now = typeof fixed === "function" ? fixed : fixed === undefined ? undefined : () => new Date(fixed);
  /** While `drain()` runs a job that waited, the time it was due: what `ctx.now()` reads then. */
  let travelled: number | undefined;
  const clock = () => {
    const base = (now ?? registryOptions.now ?? (() => new Date()))();
    return travelled !== undefined && travelled > base.getTime() ? new Date(travelled) : base;
  };
  let open: Open<S, Mods, Cf> | undefined;

  const current = () => {
    if (!open) throw new Error("[logic-sdk] No test transaction. Add beforeEach(() => t.begin()) and afterEach(() => t.rollback()).");
    return open;
  };

  function start(db: unknown, close: () => Promise<void>): Open<S, Mods, Cf> {
    const database = registryOptions.database;
    const events: Envelope[] = [];
    const stubs: Open<S, Mods, Cf>["stubs"] = new Map();
    const queued: Delivery[] = [];
    const scheduled: CallJob[] = [];
    const failures: unknown[] = [];
    const derived = registry[INTERNAL].derive({
      database: db !== undefined && database?.nest ? database.nest(db) : database,
      services: options.services,
      config: options.config,
      now: clock,
      stubs,
      record: (e) => events.push(e),
      adapter: testJobs(options.jobs, registryOptions.jobs?.adapter, queued, scheduled),
      waitUntil: undefined, // listeners finish before a call returns, inside the test
      onError(error, info) {
        if (info.outcome !== "discarded") failures.push(error);
        registryOptions.onError?.(error, info);
      },
    });
    return { registry: derived, db, events, stubs, queued, scheduled, failures, close };
  }

  /** Run `work`, then throw the first listener failure since the last one thrown (calls through `t.registry` included). */
  async function settle<T>(state: Open<S, Mods, Cf>, work: () => Promise<T>): Promise<T> {
    let out: T;
    try {
      out = await work();
    } catch (e) {
      state.failures.length = 0; // what it threw is the failure: don't report it again on the next call
      throw e;
    }
    throwFailures(state);
    return out;
  }
  function throwFailures(state: Open<S, Mods, Cf>) {
    if (!state.failures.length) return;
    const [first] = state.failures.splice(0);
    throw first;
  }

  return {
    async begin() {
      if (open)
        throw new Error(
          "[logic-sdk] t.begin() ran again before t.rollback(). Roll back in afterEach, and don't run tests that share `t` at the same time (test.concurrent).",
        );
      const database = registryOptions.database;
      if (!database) {
        open = start(undefined, async () => {});
        return;
      }
      if (!database.nest) throw new Error("[logic-sdk] This database adapter can't nest transactions, so tests can't roll back.");
      // Drizzle transactions live inside a callback: park it there until rollback.
      const opened = Promise.withResolvers<unknown>();
      const released = Promise.withResolvers<void>();
      const done = database
        .transaction(async (tx) => {
          opened.resolve(tx);
          await released.promise;
          throw new Rollback();
        })
        .catch((e) => {
          if (!(e instanceof Rollback)) throw e;
        });
      const tx = await Promise.race([opened.promise, done]); // `done` settles first only if the transaction failed to open
      open = start(tx, async () => {
        released.resolve();
        await done;
      });
    },
    /** Also throws a listener failure nothing surfaced yet (a call through `t.registry`), so the test fails. */
    async rollback() {
      const state = open;
      open = undefined;
      await state?.close();
      if (state) throwFailures(state);
    },
    as: (scope) => ({
      scope,
      run: (fn, ...args) => {
        const state = current();
        return settle(state, () => state.registry.as(scope).run(fn, ...args));
      },
    }),
    stub: (fn, impl) => void current().stubs.set(fn, impl),
    get events() {
      return current().events;
    },
    get db() {
      return current().db;
    },
    get registry() {
      return current().registry;
    },
    jobs: {
      get queued() {
        return current().queued;
      },
      get scheduled() {
        return current().scheduled;
      },
      async drain({ until } = {}) {
        const state = current();
        const end = until === undefined ? clock() : new Date(until);
        if (Number.isNaN(end.getTime())) throw new Error(`[logic-sdk] drain({ until }) needs a valid date (got ${String(until)}).`);
        try {
          for (let round = 1; ; round++) {
            const ready = [...takeDue(state.queued, end.getTime()), ...takeDue(state.scheduled, end.getTime())];
            if (!ready.length) return;
            if (round > 100) throw new Error("[logic-sdk] drain() ran 100 rounds and jobs are still due: does one reschedule itself, inside `until`, more often than you meant?");
            ready.sort((a, b) => (a.runAt ?? "").localeCompare(b.runAt ?? ""));
            for (const job of ready) {
              // the job runs at the time it was due, so a self-rescheduling one moves forward and its checks see that time
              if (job.runAt) travelled = Math.max(travelled ?? 0, Date.parse(job.runAt));
              await settle(state, () => state.registry.jobs.run(job));
            }
          }
        } finally {
          travelled = undefined;
        }
      },
      perform(listener, payload, { scope, attempt }) {
        const state = current();
        const registered = state.registry.definitions.listeners.find((l) => l.listener === listener);
        if (!registered) throw new Error("[logic-sdk] t.jobs.perform got a listener that isn't registered: export it from its module.");
        const envelope = state.registry[INTERNAL].envelope(registered.event, payload, scope);
        return settle(state, () => state.registry.jobs.run(deliveryOf(registered, envelope), { attempt }));
      },
      async tick(at) {
        const state = current();
        const jobs = state.registry[INTERNAL].due(at === undefined ? clock() : new Date(at));
        for (const job of jobs) await settle(state, () => state.registry.jobs.run(job));
        return jobs.map((job) => job.cron);
      },
    },
  };
}
