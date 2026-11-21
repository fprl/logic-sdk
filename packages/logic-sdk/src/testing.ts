import {
  internal,
  type Caller,
  type DeepPartial,
  type CallJob,
  type Delivery,
  type DeliveryOutcome,
  type Dispatcher,
  type Envelope,
  type Fn,
  type FnIn,
  type FnOut,
  type Job,
  type Listener,
  type Registry,
} from "./index.ts";

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
   * your app's adapter (an outbox, a queue) is never used.
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
  perform<O>(listener: Listener<O>, payload: O, options: { scope: S; attempt?: number }): Promise<DeliveryOutcome>;
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
  /** Listener failures during the current call. */
  failures: unknown[];
  close(): Promise<void>;
}

class Rollback extends Error {}

/**
 * The test's jobs adapter. What waits (a delayed listener, `ctx.schedule`) is held for `drain()`; other listener jobs
 * run now (`"inline"`) or wait in `queued` (`"manual"`); a cron's run (from `registry.jobs.tick`) runs, as asked for.
 */
const testJobs = (mode: TestOptions["jobs"], queued: Delivery[], scheduled: CallJob[]): Dispatcher => ({
  holds: {},
  async deliver(jobs, runner) {
    for (const job of jobs) {
      if (job.kind === "call") scheduled.push(job);
      else if (job.kind === "delivery" && (mode === "manual" || job.runAt)) queued.push(job);
      else await runner.run(job).catch(() => {}); // reported, so the test sees it
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
  const { options: registryOptions } = internal(registry);
  const fixed = options.now;
  const now = typeof fixed === "function" ? fixed : fixed === undefined ? undefined : () => new Date(fixed);
  const clock = now ?? registryOptions.now ?? (() => new Date());
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
    const derived = internal(registry).derive({
      database: db !== undefined && database?.nest ? database.nest(db) : database,
      services: options.services,
      config: options.config as object | undefined,
      now,
      stubs,
      record: (e) => events.push(e),
      adapter: testJobs(options.jobs, queued, scheduled),
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
        const cutoff = (until === undefined ? clock() : new Date(until)).getTime();
        for (let ready = due(); ready.length; ready = due())
          for (const job of ready) await settle(state, () => state.registry.jobs.run(job));
        function due(): Job[] {
          return [...takeDue(state.queued, cutoff), ...takeDue(state.scheduled, cutoff)];
        }
      },
      perform(listener, payload, { scope, attempt }) {
        const state = current();
        const registered = state.registry.definitions.listeners.find((l) => l.listener === listener);
        if (!registered) throw new Error("[logic-sdk] t.jobs.perform got a listener that isn't registered: export it from its module.");
        const envelope = internal(state.registry).envelope(registered.event, payload, scope);
        const job: Job = { kind: "delivery", id: `${registered.id}@${envelope.id}`, listener: registered.id, envelope };
        return settle(state, () => state.registry.jobs.run(job, { attempt }));
      },
      async tick(at) {
        const state = current();
        const jobs = internal(state.registry).due(at === undefined ? clock() : new Date(at));
        for (const job of jobs) await settle(state, () => state.registry.jobs.run(job));
        return jobs.map((job) => job.cron);
      },
    },
  };
}
