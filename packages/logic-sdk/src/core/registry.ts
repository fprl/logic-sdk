import { CaughtNestedFailure, describeIssues, DomainError, errorsFor, forbiddenOf, moduleOf, PRIVATE } from "./errors.ts";
import { inProcess, runsNow } from "./in-process.ts";
import { ADAPTERS, isPlainObject, makeJobs, replaceKeyOf, workersOf } from "./jobs.ts";
import { assertTimeZone, parseSchedule } from "./schedule.ts";
import { BRAND, INTERNAL } from "./types.ts";
import type {
  ActionCtx,
  Call,
  CallJob,
  CallMetaOf,
  Config,
  ConfigOf,
  Constructor,
  Cron,
  CronCtx,
  DatabaseAdapter,
  DatabaseOptions,
  DbOf,
  Envelope,
  EventDef,
  FailureInfo,
  Fn,
  Frozen,
  In,
  Job,
  JobsOptions,
  Kind,
  Listener,
  ListenerCtx,
  ListenerMetaOf,
  MutationCtx,
  Out,
  Overrides,
  OwnModules,
  QueryCtx,
  RegisteredCron,
  RegisteredEvent,
  RegisteredFn,
  RegisteredListener,
  Registry,
  RegistryOptions,
  RunOptions,
  Schema,
  ScopeOf,
  ServicesOf,
  SqlDatabase,
} from "./types.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * init: typed constructors
 * ──────────────────────────────────────────────────────────────────────────── */

type TypedOptions<C extends Config, Mods extends Record<string, object>, T> = Omit<RegistryOptions<Mods>, "wrap" | "jobs"> & {
  /** Background work: `jobs: { adapter: databaseQueue(), scope: { store, load } }`. Default: in-process, scope as-is (nothing waits). */
  jobs?: JobsOptions<ScopeOf<C>, T>;
  /** Wraps every call, including ones that fail validation or authorization: logging, tracing, audit. */
  wrap?: (call: Call<CallMetaOf<C>>, next: () => Promise<unknown>) => Promise<unknown>;
} &
  ({} extends ServicesOf<C> ? { services?: ServicesOf<C> } : { services: ServicesOf<C> }) &
  ({} extends ConfigOf<C> ? { config?: ConfigOf<C> } : { config: ConfigOf<C> }) &
  ([DbOf<C>] extends [never] ? { database?: undefined } : { database: DatabaseOptions<DatabaseAdapter<unknown, DbOf<C>>> }) &
  { modules: OwnModules<C, Mods> };

/** Keys `Config` doesn't know are errors, so a typo like `servises` can't be silently ignored. */
type OnlyKnownKeys<C> = { [K in Exclude<keyof C, keyof Config>]: never };

/**
 * Typed constructors for your app:
 *
 * ```ts
 * export const { query, mutation, action, event, listener, createRegistry } = init<Config>();
 * ```
 */
export function init<C extends Config & OnlyKnownKeys<C>>() {
  // One implementation behind the typed signature of `Constructor`: the types are the contract, the adapters check `authorize`.
  const make =
    <K extends Kind>(kind: K) =>
    (def: object) =>
      Object.freeze({ [BRAND]: kind, kind, ...def });

  return {
    /** Create the registry once at startup: `createRegistry({ modules, database, services })`. */
    createRegistry: <const Mods extends Record<string, object>, T = ScopeOf<C>>(options: TypedOptions<C, Mods, T>) =>
      build<ScopeOf<C>, Mods, ConfigOf<C>>(options as RegistryOptions<Mods>, {}), // meta in wrap is typed by CallMetaOf<C>; the values come from typed defs
    /** Reads data. Can run other queries. No writes, no events, no services. */
    query: make("query") as Constructor<C, "query">,
    /** Changes data inside one transaction. Can run queries and mutations (same transaction) and emit events. */
    mutation: make("mutation") as Constructor<C, "mutation">,
    /** Talks to the outside world (payments, email, AI). No transaction; each mutation it runs commits on its own. */
    action: make("action") as Constructor<C, "action">,
    /** Something that happened. Emitted by mutations, delivered after commit. */
    event: <S extends Schema>(def: {
      /**
       * Stable id, local to its module: in a `notifications` module, `id: "send"` is `notifications.send`. Jobs store it,
       * so set it before you rename the export and queued jobs keep finding this code. Defaults to the export name.
       */
      id?: string;
      payload: S;
    }): EventDef<In<S>, Out<S>> =>
      Object.freeze({ [BRAND]: "event" as const, kind: "event" as const, ...def }),
    /**
     * Work on a schedule, as `scope` (a cron has no caller): a handler, like a listener's, run when the clock says. Export
     * it from a module and call `registry.jobs.tick()` every minute (or from your platform's cron trigger). Must be
     * idempotent: a retry runs the whole handler again.
     * `cron({ schedule: "0 9 * * MON", scope: { kind: "system", job: "reports.weekly" }, async handler(ctx) { await ctx.run(send) } })`.
     */
    cron: <const Sc extends ScopeOf<C>>(def: CronDef<C, Sc>): Cron<C> => {
      const { id, schedule, timezone, scope, attempts, queue, meta, handler, failed } = def;
      parseSchedule(schedule);
      if (timezone !== undefined) assertTimeZone(timezone);
      checkAttempts("cron", attempts);
      // meta is checked against ListenerMetaOf<C> above and stored loose, like a listener's, for wrap and adapters
      return Object.freeze({ [BRAND]: "cron" as const, kind: "cron" as const, id, schedule, timezone, scope, attempts, queue, meta: meta as Cron["meta"], handler, failed });
    },
    /**
     * React to an event after commit, like an action. Must be idempotent.
     * `listener({ event: () => bookings.confirmed, async handler(ctx, payload) {…} })`
     */
    listener: <O>(def: {
      /**
       * Stable id, local to its module: in a `notifications` module, `id: "send"` is `notifications.send`. Jobs store it,
       * so set it before you rename the export and queued jobs keep finding this code. Defaults to the export name.
       */
      id?: string;
      /** The event it reacts to, as a thunk so modules can import each other's barrels without cycles. */
      event: () => EventDef<unknown, O>;
      /**
       * Tries in total, the first included, like Laravel's `$tries`. Default 1: a retry repeats side effects, so opt in.
       * Once they're used, the job is `failed` (kept by `databaseQueue` and `outbox`, retried with `registry.jobs.retry(id)`).
       */
      attempts?: number;
      /** Seconds after the event before the first try. Needs an adapter that holds jobs: `inProcess()` is refused. */
      delay?: number;
      /**
       * Whether this event gets a job for this listener, like Laravel's `shouldQueue($event)`: false, and nothing is
       * stored, run or counted. From the payload the handler gets (parsed), at commit, so sync and from the event only:
       * a condition on the database belongs in the handler, since it can change before the job runs. A throw fails the
       * mutation, as a bad payload does.
       */
      when?: (payload: O) => boolean;
      /**
       * Jobs with the same key run one at a time, in the order their events were emitted, like Laravel's message groups
       * on SQS FIFO: `key: (m) => m.conversationId`. Waiting spends no attempt; a try backing off holds the key, a job
       * that failed for good frees it. Per listener. Needs an adapter that runs a key's jobs in order: others are refused.
       * Inside its handler, run functions with `ctx.run`: calling the registry directly for the same key waits on itself.
       */
      key?: (payload: O) => string;
      /**
       * While a job with the same value hasn't started, later ones are dropped, like Laravel's
       * `ShouldBeUniqueUntilProcessing`: `unique: (p) => p.productId`. **It drops events, so the handler must read
       * current state, never the payload's data**: for "X changed, recompute X". Once the job starts, the next event
       * queues a new one.
       */
      unique?: (payload: O) => string;
      /**
       * Seconds a try may run, like Laravel's `$timeout`. Past it, `ctx.signal` aborts, no new `ctx.run` starts, and
       * the try counts as failed (retried while `attempts` are left). JavaScript can't stop code mid-flight: a mutation
       * already running still commits.
       */
      timeout?: number;
      /**
       * Its queue, one of `jobs.queues`: `queue: "mail"`. Default `"default"`. A worker takes its queues in the order it
       * lists them: `work(registry, { queues: ["mail", "default"] })`.
       */
      queue?: string;
      meta?: ListenerMetaOf<C>;
      handler: (ctx: ListenerCtx<C, O>, payload: O) => Promise<unknown>;
      /**
       * Runs once its last try has failed, with the handler's ctx and payload, and the error: undo or flag what the
       * handler started (`await ctx.run(orders.flagReceipt, { orderId })`). Not in a transaction: run mutations. At most
       * once (a crash right after the failure skips it), and not for a job that can't run anymore (its payload or event
       * changed, or `scope.load` returned null). A throw is reported to `onError`; the job stays failed.
       */
      failed?: (ctx: ListenerCtx<C, O>, payload: O, error: unknown) => Promise<unknown>;
    }): Listener<O, C> => {
      const { id, event, attempts, delay, when, key, unique, timeout, queue, meta, handler, failed } = def;
      checkAttempts("listener", attempts);
      if (delay !== undefined && !(Number.isFinite(delay) && delay >= 0))
        throw new Error(`[logic-sdk] listener delay must be seconds, 0 or more (got ${delay}).`);
      if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0))
        throw new Error(`[logic-sdk] listener timeout must be seconds, more than 0 (got ${timeout}).`);
      // two jobs of one key with different values would be inserted in `unique` order (the lock order), not emit order
      if (key && unique) throw new Error("[logic-sdk] a listener takes key or unique, not both: key runs every job in order, unique drops the ones waiting.");
      // meta is checked against ListenerMetaOf<C> above and stored loose, like Fn.meta, for wrap and adapters
      return Object.freeze({ [BRAND]: "listener" as const, kind: "listener" as const, id, event, attempts, delay, when, key, unique, timeout, queue, meta: meta as Listener["meta"], handler, failed });
    },
  };
}

/** `cron({...})`: its handler's `ctx.scope` is the scope it declares, so a policy-free read of it is typed. */
type CronDef<C extends Config, Sc> = {
  /**
   * Stable id, local to its module, like every definer's. Defaults to the export name. Jobs store it, so set it before you
   * rename the export.
   */
  id?: string;
  /** Five fields: minute hour day-of-month month day-of-week. `"*\/15 * * * *"`, `"0 9 * * MON"`. */
  schedule: string;
  /** IANA name, like `"Europe/Madrid"`. Default UTC. Matched on the wall clock, like Laravel: mind DST at 1 to 3 am. */
  timezone?: string;
  /** Who it runs as: a cron has no caller. Every function the handler runs checks its policy against it. */
  scope: Sc;
  /** Tries in total, like a listener's. Default 1: a retry runs the whole handler again. */
  attempts?: number;
  /** Its queue, one of `jobs.queues`, like a listener's. Default `"default"`. */
  queue?: string;
  meta?: ListenerMetaOf<C>;
  /** The work, like a listener's handler: an action's ctx, plus `ctx.cron` (`scheduledAt`, `attempt`). */
  handler: (ctx: CronCtx<C, Sc>) => Promise<unknown>;
  /** Runs once its last try has failed, like a listener's `failed`: the handler's ctx, and the error. */
  failed?: (ctx: CronCtx<C, Sc>, error: unknown) => Promise<unknown>;
};

/** How deep `ctx.run` calls may nest. Past it, a function is running itself without end. */
const MAX_RUN_DEPTH = 64;

function checkAttempts(what: string, attempts: number | undefined) {
  if (attempts !== undefined && !(Number.isInteger(attempts) && attempts >= 1))
    throw new Error(`[logic-sdk] ${what} attempts must be a whole number of tries, 1 or more (got ${attempts}).`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * createRegistry
 * ──────────────────────────────────────────────────────────────────────────── */

interface TxState {
  db: unknown;
  doomed: boolean;
  reason: unknown;
  /** Where the transaction's own mutation sits in the trail: what the error at commit prints starts there. */
  from: number;
  /** The calls down to the nested mutation whose failure doomed it, from the transaction's own mutation. */
  doomedBy: readonly string[] | undefined;
  events: Envelope[];
  /** Each event's payload as its schema parsed it, for listeners' `when`: the value their handler gets. */
  parsed: Map<Envelope, unknown>;
  /** What `ctx.schedule` asked for, enqueued with the events at commit. */
  calls: CallJob[];
  pending: Promise<void>[];
}
interface Frame {
  scope: object;
  /** The calls that led here, outermost first. How many there are is the next call's depth. */
  trail: readonly string[];
  /** Inherited, for actions to pass on as ctx.signal. */
  signal?: AbortSignal;
  /** Passed to this very call: checked before it starts. */
  abortOn?: AbortSignal;
  /** A listener's `timeout`: once it's aborted, no call from here starts. */
  stop?: AbortSignal;
  /** Hops in the chain of events and calls due now that led here: 0 for a call from outside. */
  eventDepth: number;
  /** Inside a job: where the jobs it queues wait until it's settled. */
  queued?: Job[];
  /** A scheduled call's own run: which job and try, for `wrap`'s call. */
  job?: { id: string; attempt: number };
  tx?: TxState;
}

/** What a mutation throws at commit when a nested mutation failed and was caught: the transaction they share is doomed. */
function caughtNestedFailure(id: string, tx: TxState): CaughtNestedFailure {
  let why: string;
  try {
    why = tx.reason instanceof Error ? tx.reason.message : String(tx.reason);
  } catch {
    why = Object.prototype.toString.call(tx.reason); // an object String() can't print
  }
  return new CaughtNestedFailure(
    `[logic-sdk] ${tx.doomedBy?.at(-1)} failed inside ${id}'s transaction (${tx.doomedBy?.join(" → ")}) and was ` +
      `caught, so ${id} can't commit: a mutation shares its transaction with the mutations it runs. To let each one ` +
      `commit or fail on its own, run them from an action. The failure (this error's cause): ${why}`,
    { cause: tx.reason },
  );
}

/** Create the registry once at startup. Prefer the `createRegistry` returned by `init()`: it's typed with your config. */
export function createRegistry<S extends object = object, const Mods extends Record<string, object> = Record<string, object>>(
  options: RegistryOptions<Mods>,
) {
  return build<S, Mods>(options, {});
}

/** Plain objects merge key by key; anything else (values, arrays, null) replaces. `undefined` keeps the base. */
function mergeConfig(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const keys = new Set([...Object.keys(base), ...Object.keys(patch)]);
  return Object.fromEntries([...keys].map((k) => [k, mergeConfig(base[k], patch[k])])); // fromEntries: `__proto__` stays a key
}

/** A frozen copy of plain data, so settings can't change under everyone else or hide behavior (a client, a class). */
function freezeConfig(value: unknown): unknown {
  assertPlain(value, "config", "config holds plain data: pass a Date as an ISO string, and put clients in services");
  const freeze = (v: unknown): unknown => {
    if (v && typeof v === "object") {
      for (const item of Object.values(v)) freeze(item);
      Object.freeze(v);
    }
    return v;
  };
  return freeze(structuredClone(value));
}

/**
 * Plain data, what survives JSON: plain objects, arrays, strings, finite numbers, booleans, null (undefined is dropped).
 * Anything else (a Date, a Map, a class instance, a function, a cycle) is rejected with its path.
 */
function assertPlain(value: unknown, what: string, hint: string): void {
  const seen = new Set<object>();
  const check = (v: unknown, path: string): void => {
    const fail = (found: string): never => {
      throw new Error(`[logic-sdk] ${what} isn't plain data${path ? ` at ${path}` : ""}: ${found}. ${hint}.`);
    };
    if (v === null || v === undefined || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) fail(String(v));
      return;
    }
    if (typeof v !== "object") return fail(`a ${typeof v}`);
    if (seen.has(v)) fail("a circular reference");
    seen.add(v);
    if (Array.isArray(v)) v.forEach((item, i) => check(item, `${path}[${i}]`));
    else {
      if (!isPlainObject(v)) fail(`a ${v.constructor?.name ?? "class instance"}`);
      for (const [k, item] of Object.entries(v)) check(item, path ? `${path}.${k}` : k);
    }
    seen.delete(v);
  };
  check(value, "");
}

const isBranded = (v: unknown): v is Fn | EventDef | Listener | Cron => !!v && typeof v === "object" && BRAND in v;

/**
 * What `createRegistry` finds in your modules, without a database or services: every function, event, listener and
 * cron with its id. For tools (the CLI, docs generators) that inspect an app without running it.
 */
export function describeModules(modules: Record<string, object>) {
  const ids = new Map<object, string>();
  const functions: RegisteredFn[] = [];
  const events: RegisteredEvent[] = [];
  const listeners: RegisteredListener[] = [];
  const crons: RegisteredCron[] = [];

  const taken = new Map<string, string>();

  for (const [module, ns] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(ns)) {
      if (!isBranded(value) || ids.has(value)) continue;
      const local = value.id ?? name;
      if (value.id !== undefined && (typeof value.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.id)))
        throw new Error(`[logic-sdk] ${module}.${name} has id ${JSON.stringify(value.id)}. Give the local name ("send"): the module key is added, so it's ${module}.<id>.`);
      const id = `${module}.${local}`;
      const other = taken.get(id);
      if (other) throw new Error(`[logic-sdk] ${module}.${other} and ${module}.${name} both have the id ${id}. Ids must be unique: jobs find their code by it.`);
      taken.set(id, name);
      ids.set(value, id);
      if (value.kind === "event") events.push({ id, module, name, event: value });
      else if (value.kind === "listener") listeners.push({ id, module, name, listener: value, event: value.event() });
      else if (value.kind === "cron") crons.push({ id, module, name, cron: value });
      else functions.push({ id, module, name, kind: value.kind, fn: value });
    }
  }
  return { ids, functions, events, listeners, crons };
}

function build<S extends object, Mods extends Record<string, object>, Cf = unknown>(
  options: RegistryOptions<Mods>,
  o: Overrides,
): Registry<S, Mods, Cf> {
  const { ids, functions, events, listeners, crons } = describeModules(options.modules);

  const database = o.database ?? options.database?.adapter;
  const services = o.services ?? options.services ?? {};
  const config = freezeConfig(mergeConfig(options.config ?? {}, o.config)) as Frozen<Cf>;
  const jobsAdapter = o.adapter ?? options.jobs?.adapter ?? inProcess();
  const jobScope = options.jobs?.scope;
  if (jobScope?.store && !jobScope.load) throw new Error("[logic-sdk] jobs.scope has store but no load. Jobs run as a scope, so rebuild it from what store saved.");
  // a job any adapter but inProcess() keeps runs as a scope saved earlier: rebuild it, or its roles are the ones from
  // back then (AshOban's actor_persister). The app's adapter, so a test registry agrees with the app it wraps.
  const appAdapter = options.jobs?.adapter;
  if (appAdapter && !runsNow(appAdapter) && !jobScope?.load)
    throw new Error(
      "[logic-sdk] Your jobs adapter keeps jobs to run later, so set jobs.scope.load: it rebuilds the scope when a job runs, with today's " +
        "roles (null discards the job). Add `store` to save only ids. To keep the scope as it was, `load: (saved) => saved`.",
    );
  const now = o.now ?? options.now ?? (() => new Date());
  const wrap = options.wrap ?? ((_c, next) => next());
  const maxEventDepth = options.jobs?.maxEventDepth ?? 8;
  checkAttempts("database transaction", options.database?.transactionAttempts);
  const transactionAttempts = options.database?.transactionAttempts ?? 3; // the app's, so a test's nested adapter keeps it
  const waitUntil = "waitUntil" in o ? o.waitUntil : options.waitUntil; // tests turn it off: listeners finish inside the test
  const reportRaw =
    o.onError ?? options.onError ?? ((e, info) => console.error(`[logic-sdk] ${info.source} failed`, e));
  const report = (e: unknown, info: FailureInfo) => {
    try {
      reportRaw(e, info);
    } catch (inner) {
      console.error("[logic-sdk] onError threw", inner, "while reporting", e);
    }
  };

  const noDatabase =
    "[logic-sdk] Mutations need a database: createRegistry({ database: { adapter } }), on a driver with interactive " +
    "transactions (see Adapters in the docs).";
  if (!database && functions.some((f) => f.kind === "mutation")) throw new Error(noDatabase);
  for (const l of listeners)
    if (!ids.has(l.event))
      throw new Error(`[logic-sdk] Listener ${l.id} listens to an event that isn't registered in any module.`);
  const failedStore = o.failed === null ? undefined : (o.failed ?? options.jobs?.failed);
  const sql = database && "query" in database ? (database as SqlDatabase) : undefined;
  for (const adapter of [jobsAdapter, failedStore])
    if (adapter?.sql && !sql)
      throw new Error(
        `[logic-sdk] ${adapter.name ?? "Your jobs adapter"} writes in your mutation's transaction with SQL, so it needs ` +
          "createRegistry({ database: { adapter } }) with an adapter that runs SQL (`query`). See Adapters, Other ORMs in the docs.",
      );
  const setup = { sql, workers: workersOf(jobsAdapter) };
  jobsAdapter.connect?.(setup);
  failedStore?.connect?.(setup);

  const idOf = (x: object) => {
    const id = ids.get(x);
    if (!id)
      throw new Error(
        "[logic-sdk] This function or event isn't registered. Export it from its module's index.ts, and add the module to createRegistry({ modules }). " +
          "A private function (one the index doesn't export) runs only through ctx.run, from its own module.",
      );
    return id;
  };

  /** Bad input from a caller is their error. Bad input from your own code (a nested call) is a bug. */
  async function parseInput(schema: Schema, value: unknown, id: string, nested: boolean) {
    const r = await schema["~standard"].validate(value);
    if (!r.issues) return r.value;
    const issues = describeIssues(r.issues);
    if (nested) throw new Error(`[logic-sdk] ${id} was run with invalid input: ${JSON.stringify(issues)}`);
    throw new DomainError("invalid", `${id}.invalid_input`, { issues });
  }
  /** Output and event payloads are produced by our own code: invalid means a bug, not a bad request. */
  async function parseOwn(schema: Schema, value: unknown, what: string) {
    const r = await schema["~standard"].validate(value);
    if (r.issues) throw new Error(`[logic-sdk] ${what} is invalid: ${JSON.stringify(describeIssues(r.issues))}`);
    return r.value;
  }
  /** What our own code passed a mutation's ctx, checked by the time it commits: a bad value fails the commit. */
  function checkAtCommit(tx: TxState, schema: Schema, value: unknown, what: string, keep?: (parsed: unknown) => void) {
    const check = parseOwn(schema, value, what).then((parsed) => keep?.(parsed));
    check.catch(() => {}); // surfaced at commit; never an unhandled rejection
    tx.pending.push(check);
  }

  // ── ctx ──────────────────────────────────────────────────────────────────
  /** The frame for a call from here: its scope and signal. `invoke` adds the call to the trail. */
  const enter = (frame: Frame, options: RunOptions | undefined): Frame => ({
    ...frame,
    scope: options?.scope ?? frame.scope,
    signal: options?.signal ?? frame.signal,
    abortOn: options?.signal,
  });

  /** What every ctx has. `allowed`: the kinds its `run` may call. */
  const baseCtx = (frame: Frame, id: string, allowed: Kind[]) => ({
    errors: errorsFor(id),
    scope: frame.scope,
    config: config as any, // Frozen<Cf> here; each app's ctx types it from its own Config
    now,
    run: (fn: Fn, input?: unknown, options?: RunOptions) => invoke(fn, input, enter(frame, options), allowed, moduleOf(id)),
  });
  const queryCtx = (frame: Frame, id: string): QueryCtx<any> => ({
    ...baseCtx(frame, id, ["query"]),
    db: frame.tx ? frame.tx.db : database?.db,
  });
  function mutationCtx(frame: Frame, tx: TxState, id: string): MutationCtx<any> {
    return {
      ...baseCtx(frame, id, ["query", "mutation"]),
      db: tx.db,
      emit: (event, payload) => {
        // reserve the slot now so events keep emit order, even with async schemas
        const envelope = envelopeOf(event, payload, frame.scope, frame.eventDepth + 1);
        tx.events.push(envelope);
        checkAtCommit(tx, event.payload, envelope.payload, `${envelope.name} payload`, (parsed) => tx.parsed.set(envelope, parsed));
        // a copy: changing it can't change what's delivered
        return Object.freeze({ id: envelope.id, name: envelope.name, payload: structuredClone(envelope.payload) as typeof payload, occurredAt: envelope.occurredAt });
      },
      schedule: (fn, input, { at, delay, attempts = 1, replace, scope, queue }) => {
        const fnId = ids.get(fn);
        if (!fnId)
          throw new Error(
            "[logic-sdk] ctx.schedule needs a function its module's index.ts exports: a scheduled call waits as a name, and a worker finds the code by it. " +
              "A private function runs only through ctx.run.",
          );
        const seconds = at ? (at.getTime() - now().getTime()) / 1000 : (delay ?? NaN);
        if (!Number.isFinite(seconds) || (!at && seconds < 0))
          throw new Error(`[logic-sdk] ctx.schedule(${fnId}) needs an \`at\` date or a \`delay\` in seconds, 0 or more.`);
        checkAttempts(`ctx.schedule(${fnId})`, attempts);
        checkRetries(`ctx.schedule(${fnId})`, attempts);
        checkQueue(`ctx.schedule(${fnId})`, queue);
        if (replace !== undefined) {
          if (!jobsAdapter.replaces)
            throw new Error(`[logic-sdk] ctx.schedule(${fnId}) replaces a waiting call, but ${yours} can't replace one it already has. Use one that can (${ADAPTERS}).`);
        }
        // due now (no delay, or an `at` already past): runs after commit like a listener, no holding needed
        const waits = seconds > 0;
        if (waits) checkHold(`ctx.schedule(${fnId})`, seconds);
        assertPlain(input, `${fnId} input`, "Scheduled calls wait as JSON: send an ISO string and let the schema turn it into a Date");
        const job: CallJob = {
          kind: "call",
          id: `${fnId}@${crypto.randomUUID()}`,
          fn: fnId,
          input: structuredClone(input),
          scope: storedScope(scope ?? frame.scope, `the scope scheduling ${fnId}`), // `scope`: whole, as ctx.run takes it
          attempts,
          depth: waits ? 0 : frame.eventDepth + 1, // due now, it's the next hop of this chain; a real wait starts a new one
        };
        if (waits) job.runAt = new Date(now().getTime() + seconds * 1000).toISOString();
        if (queue) job.queue = queue;
        if (replace) {
          job.replace = true;
          // scheduled twice in this transaction: the later one wins here too (the dropped one's input is still checked:
          // a bad input is a bug wherever it is)
          const earlier = tx.calls.findIndex((c) => replaceKeyOf(c) === replaceKeyOf(job));
          if (earlier >= 0) tx.calls.splice(earlier, 1);
        }
        tx.calls.push(job);
        // our own code passed it: a bad input is a bug, surfaced at commit like an event's payload
        if (fn.input) checkAtCommit(tx, fn.input, job.input, `${fnId} input`);
      },
    };
  }
  /** An emitted event as jobs carry it: plain JSON, and copied, so what was emitted is what gets delivered. */
  function envelopeOf(event: EventDef, payload: unknown, scope: object, depth: number): Envelope {
    const name = idOf(event);
    // a queue carries JSON: a Date or a class instance would work in-process and break only in production
    assertPlain(payload, `${name} payload`, "Events travel through queues as JSON: send an ISO string and let the schema turn it into a Date");
    return { id: crypto.randomUUID(), name, payload: structuredClone(payload), scope: storedScope(scope, `the scope emitting ${name}`), occurredAt: now().toISOString(), depth };
  }
  /** What a job keeps of the scope it runs as: `jobs.scope.store`'s pick, as a JSON copy. */
  function storedScope(scope: object, what: string): object {
    const stored = jobScope?.store ? jobScope.store(scope) : scope;
    assertPlain(stored, what, "Jobs carry the scope through queues as JSON: keep it to ids (jobs.scope.store picks what's saved)");
    return structuredClone(stored);
  }

  const actionCtx = (frame: Frame, id: string): ActionCtx<any> => ({
    ...baseCtx(frame, id, ["query", "mutation", "action"]),
    signal: frame.signal,
    services,
  });

  const { toJobs, deliver, jobs, due, checkHold, checkRetries, checkQueue, yours } = makeJobs({
    listeners,
    crons,
    functions,
    idOf,
    jobsAdapter,
    database,
    jobScope,
    failedStore,
    maxEventDepth,
    queues: options.jobs?.queues ?? [],
    now,
    wrap,
    report,
    runAs: (fn, input, scope, eventDepth, queued, job) => invoke(fn, input, enter({ scope, trail: [], eventDepth, queued, job }, undefined), ["query", "mutation", "action"]),
    handlerCtx: (scope, eventDepth, id, queued, stop) => actionCtx({ scope, trail: [id], eventDepth, queued, signal: stop, stop }, id),
  });

  // ── invoke ───────────────────────────────────────────────────────────────
  /** `callerModule`: set by ctx.run, so a private function (its index doesn't export it) runs as part of the module running it. */
  async function invoke(fn: Fn, rawInput: unknown, outer: Frame, allowed: Kind[], callerModule?: string): Promise<any> {
    // anything else that runs one finds it by name, and it has none: idOf throws, saying so
    const id = ids.get(fn) ?? (callerModule ? `${callerModule}.${fn.id ?? PRIVATE}` : idOf(fn));
    if (!allowed.includes(fn.kind))
      throw new Error(`[logic-sdk] ${id} is a ${fn.kind}; it can't be run from here (allowed: ${allowed.join(", ")}).`);
    const depth = outer.trail.length;
    // a function that runs itself, through other modules or not, never returns: stop it with the path, not run out of memory
    if (depth > MAX_RUN_DEPTH)
      throw new Error(
        `[logic-sdk] ctx.run nested past ${MAX_RUN_DEPTH} calls: … → ${[...outer.trail.slice(-6), id].join(" → ")}. ` +
          "Recurse in a plain helper that takes ctx, or make each step separate work (an event, or ctx.schedule).",
      );
    const frame: Frame = { ...outer, trail: [...outer.trail, id] };

    const call: Call = { id, kind: fn.kind, meta: fn.meta, input: rawInput, scope: frame.scope, depth };
    if (depth === 0 && outer.job) call.job = outer.job; // the job's own call, not what it runs

    /** Authorize, then validate, before any transaction opens: denied or bad calls never touch the database. */
    const prepare = async () => {
      frame.abortOn?.throwIfAborted();
      frame.stop?.throwIfAborted();
      if (fn.authorize) {
        // SAFETY: the registry erases each policy's scope type; the caller's scope is the app's Scope by construction
        if (fn.authorize(frame.scope as never) !== true) throw new DomainError("forbidden", forbiddenOf(id));
      }
      // no `input`: the function takes nothing, whatever an adapter sends (AI tools send `{}`)
      return fn.input ? parseInput(fn.input, rawInput, id, depth > 0) : undefined;
    };
    const execute = async (input: unknown, ctx: unknown) => {
      // SAFETY: the handler's types were erased when it was registered. `ctx` was built for its kind,
      // and `input` just passed its own schema (or it takes none).
      const handler = o.stubs?.get(fn) ?? fn.handler;
      const out = await handler(ctx as never, input as never);
      return fn.output ? parseOwn(fn.output, out, `${id} output`) : out;
    };

    return wrap(call, async () => {
      if (fn.kind === "query") return execute(await prepare(), queryCtx(frame, id));
      if (fn.kind === "action") return execute(await prepare(), actionCtx(frame, id));

      // mutation joining an open transaction: any failure dooms it, even if the caller catches
      if (frame.tx) {
        const tx = frame.tx;
        try {
          return await execute(await prepare(), mutationCtx(frame, tx, id));
        } catch (e) {
          if (!tx.doomed) {
            tx.doomed = true;
            tx.reason = e;
            tx.doomedBy = frame.trail.slice(tx.from);
          }
          throw e;
        }
      }

      // top-level mutation: open the transaction, commit, then deliver events.
      // createRegistry checks for one, but a private mutation isn't registered, so it can only be checked here
      if (!database) throw new Error(noDatabase);
      const input = await prepare();
      const committed = await commitWithRetries(database, frame, id, (tx) => execute(input, mutationCtx({ ...frame, tx }, tx, id)));

      // committed. Nothing below may fail the caller.
      // a try past its timeout is settled already: what it still commits is delivered now, not after it
      await afterCommit(committed.events, committed.jobs, frame.stop?.aborted ? undefined : frame.queued);
      return committed.out;
    });
  }

  /**
   * A top-level mutation's transaction: run it, check nothing inside was caught and ignored, queue its jobs, commit. A
   * lost race (deadlock, serialization failure) re-runs it in a fresh transaction, up to `transactionAttempts`.
   */
  async function commitWithRetries(
    database: DatabaseAdapter<unknown, unknown>,
    frame: Frame,
    id: string,
    run: (tx: TxState) => Promise<unknown>,
  ): Promise<{ out: unknown; events: Envelope[]; jobs: Job[] }> {
    for (let attempt = 1; ; attempt++) {
      const attemptTx: { current?: TxState } = {};
      try {
        return await database.transaction(async (txDb) => {
          // fresh per attempt, so a retry never reuses events from a failed attempt
          const tx: TxState = {
            db: txDb, doomed: false, reason: undefined, from: frame.trail.length - 1, doomedBy: undefined,
            events: [], parsed: new Map(), calls: [], pending: [],
          };
          attemptTx.current = tx;
          const out = await run(tx);
          await Promise.all(tx.pending);
          // a nested failure was caught: a bug, so its own error, with the failure as its cause (Ecto's aborted
          // transaction). Retries still see a deadlock: `retryable` walks causes
          if (tx.doomed) throw caughtNestedFailure(id, tx);
          const jobs = toJobs(tx.events, tx.calls, tx.parsed);
          if (jobs.length) await jobsAdapter.enqueue?.(txDb, jobs);
          return { out, events: tx.events, jobs };
        });
      } catch (e) {
        // a lost race dooms the transaction even when a caller caught it and went on: Postgres then fails the next
        // statement with 25P02, or the caller throws its own error, and the race is still what to retry
        const doomed = attemptTx.current?.doomed ? attemptTx.current.reason : undefined;
        const lostRace = database.retryable?.(e) || (doomed !== undefined && database.retryable?.(doomed));
        if (attempt < transactionAttempts && lostRace) {
          // a random pause, so transactions that just deadlocked don't retry in lockstep and collide again
          await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
          continue;
        }
        throw e;
      }
    }
  }

  async function afterCommit(emitted: Envelope[], jobs: Job[], queued: Job[] | undefined) {
    try {
      for (const e of emitted) o.record?.(e);
      if (!jobs.length) return;
      if (queued) return void queued.push(...jobs); // queued by a job: delivered once that job is settled
      const delivery = deliver(jobs);
      if (waitUntil) {
        try {
          waitUntil(delivery);
          return;
        } catch (e) {
          report(e, { source: "(waitUntil)" });
        }
      }
      await delivery;
    } catch (e) {
      report(e, { source: "(after commit)" });
    }
  }

  return {
    as: (scope) => ({
      scope,
      run: (fn: Fn, input?: unknown, options?: RunOptions) =>
        invoke(fn, input, enter({ scope, trail: [], eventDepth: 0 }, options), ["query", "mutation", "action"]),
    }),
    definitions: { functions, events, listeners, crons },
    idOf,
    jobs,
    [INTERNAL]: {
      options,
      derive: (more: Overrides) => build<S, Mods, Cf>(options, { ...o, ...more, config: mergeConfig(o.config, more.config) }),
      envelope: (event, payload, scope) => envelopeOf(event, payload, scope, 1),
      due,
    },
  };
}
