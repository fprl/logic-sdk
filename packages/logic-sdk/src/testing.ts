import {
  inProcess,
  internal,
  type Caller,
  type DeepPartial,
  type DeliveryOutcome,
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
   * `testing: :inline | :manual`. Either way your app's adapter (an outbox, a queue) is never used.
   */
  jobs?: "inline" | "manual";
}

/** The jobs of the current test, like `registry.jobs` in production. */
export interface TestJobs<S> {
  /** What committed mutations queued and nothing ran yet (`jobs: "manual"`). */
  readonly queued: readonly Job[];
  /** Run the queued jobs, and the ones they queue, until none are left. Throws a listener's failure. */
  drain(): Promise<void>;
  /** Run one listener by hand, as if its event had been emitted as `scope`. Throws its failure, like `drain()`. */
  perform<O>(listener: Listener<O>, payload: O, options: { scope: S; attempt?: number }): Promise<DeliveryOutcome>;
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
  queued: Job[];
  /** Listener failures during the current call. */
  failures: unknown[];
  close(): Promise<void>;
}

class Rollback extends Error {}

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
  let open: Open<S, Mods, Cf> | undefined;

  const current = () => {
    if (!open) throw new Error("[logic-sdk] No test transaction. Add beforeEach(() => t.begin()) and afterEach(() => t.rollback()).");
    return open;
  };

  function start(db: unknown, close: () => Promise<void>): Open<S, Mods, Cf> {
    const database = registryOptions.database;
    const events: Envelope[] = [];
    const stubs: Open<S, Mods, Cf>["stubs"] = new Map();
    const queued: Job[] = [];
    const failures: unknown[] = [];
    const derived = internal(registry).derive({
      database: db !== undefined && database?.nest ? database.nest(db) : database,
      services: options.services,
      config: options.config as object | undefined,
      now,
      stubs,
      record: (e) => events.push(e),
      adapter: options.jobs === "manual" ? { deliver: async (jobs) => void queued.push(...jobs) } : inProcess(),
      waitUntil: undefined, // listeners finish before a call returns, inside the test
      onError(error, info) {
        if (info.outcome !== "discarded") failures.push(error);
        registryOptions.onError?.(error, info);
      },
    });
    return { registry: derived, db, events, stubs, queued, failures, close };
  }

  /** Run `work`, then throw the first listener failure since the last one thrown (calls through `t.registry` included). */
  async function settle<T>(state: Open<S, Mods, Cf>, work: () => Promise<T>): Promise<T> {
    const out = await work();
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
      async drain() {
        const state = current();
        while (state.queued.length)
          for (const job of state.queued.splice(0)) await settle(state, () => state.registry.jobs.run(job));
      },
      perform(listener, payload, { scope, attempt }) {
        const state = current();
        const registered = state.registry.definitions.listeners.find((l) => l.listener === listener);
        if (!registered) throw new Error("[logic-sdk] t.jobs.perform got a listener that isn't registered: export it from its module.");
        const store = registryOptions.jobs?.scope?.store;
        const eventId = crypto.randomUUID();
        const job: Job = {
          kind: "delivery",
          id: `${registered.id}@${eventId}`,
          listener: registered.id,
          envelope: {
            id: eventId,
            name: state.registry.idOf(registered.event),
            payload,
            scope: store ? store(scope) : scope,
            occurredAt: (now ?? registryOptions.now ?? (() => new Date()))().toISOString(),
            depth: 1,
          },
        };
        return settle(state, () => state.registry.jobs.run(job, { attempt }));
      },
    },
  };
}
