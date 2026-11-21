import { internal, type Caller, type DeepPartial, type Envelope, type Fn, type FnIn, type FnOut, type Registry } from "./index.ts";

export interface TestOptions<Cf = unknown> {
  /** Replace services (e.g. `{ mailer: memoryMailer() }`). */
  services?: object;
  /** Override parts of `config` (e.g. `{ orders: { maxItems: 1 } }`). Merged over the registry's, section by section. */
  config?: DeepPartial<Cf>;
  /** Freeze time. */
  now?: Date | string | (() => Date);
  /** Run listeners inline after each mutation (default), or not at all to test one module in isolation. */
  listeners?: boolean;
}

export interface TestTransaction<S extends object, Mods extends Record<string, object> = Record<string, object>, Cf = unknown> {
  /** Bind who is calling, exactly like `registry.as(...)`. */
  as(scope: S): Caller<S>;
  /** Replace a function's implementation for this test. Matched by identity, so `run(availability.hold, …)` hits the stub. */
  stub<F extends Fn>(fn: F, impl: (ctx: unknown, input: FnIn<F>) => Promise<FnOut<F>>): void;
  /** Every event emitted (and committed) so far, in order. */
  readonly events: Envelope[];
  /** The test transaction itself: read rows to assert on them. */
  readonly db: any;
  /** The registry bound to this test transaction, for adapters: `toFetchHandler(tx.registry, …)`. */
  readonly registry: Registry<S, Mods, Cf>;
}

class Rollback extends Error {}

/**
 * Run each test inside a transaction that is always rolled back.
 * Every top-level mutation inside becomes a savepoint, so a failing mutation rolls back just its own writes,
 * like it would in production. Run top-level mutations one at a time inside a test (one connection, nested savepoints).
 */
export function createTestRegistry<S extends object, Mods extends Record<string, object>, Cf>(
  registry: Registry<S, Mods, Cf>,
  options: TestOptions<Cf> = {},
) {
  const { options: registryOptions } = internal(registry);
  const fixed = options.now;
  const now = typeof fixed === "function" ? fixed : fixed === undefined ? undefined : () => new Date(fixed);

  return {
    async transaction<T>(fn: (t: TestTransaction<S, Mods, Cf>) => Promise<T>): Promise<T> {
      const database = registryOptions.database;
      let result!: T;

      const body = async (outer: unknown) => {
        const stubs = new Map<Fn, (ctx: never, input: never) => Promise<unknown>>();
        const events: Envelope[] = [];
        const derived = internal(registry).derive({
          database: outer !== undefined && database?.nest ? database.nest(outer) : database,
          services: options.services,
          config: options.config as object | undefined,
          now,
          stubs,
          record: (e) => events.push(e),
          jobs: options.listeners === false ? { deliver: async () => {} } : undefined,
        });
        result = await fn({
          as: (scope) => derived.as(scope),
          stub: (f, impl) => void stubs.set(f, impl),
          events,
          db: outer,
          registry: derived,
        });
      };

      if (!database) {
        await body(undefined);
        return result;
      }
      if (!database.nest) throw new Error("[logic-sdk] This database adapter can't nest transactions, so tests can't roll back.");
      try {
        await database.transaction(async (outer) => {
          await body(outer);
          throw new Rollback();
        });
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
      }
      return result;
    },
  };
}
