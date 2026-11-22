import { describeIssues, DomainError, errorsFor } from "./errors.ts";
import { inProcess, makeJobs, replaceKeyOf, runsNow } from "./jobs.ts";
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
  DatabaseAdapter,
  DbOf,
  Envelope,
  EventDef,
  FailureInfo,
  Fn,
  FnIn,
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
} from "./types.ts";

export type {
  ActionCtx,
  Call,
  CallJob,
  Caller,
  Config,
  Constructor,
  Cron,
  CronJob,
  DatabaseAdapter,
  DeepPartial,
  Delivery,
  DeliveryOutcome,
  Dispatcher,
  Envelope,
  Errors,
  EventDef,
  ExposedFn,
  ExposedOf,
  FailureInfo,
  Fn,
  FnIn,
  FnOut,
  ForFunctions,
  ForListeners,
  Frozen,
  In,
  Job,
  JobScope,
  Jobs,
  JobsOptions,
  Kind,
  Listener,
  ListenerCtx,
  ListenerEvent,
  MutationCtx,
  Out,
  Overrides,
  Policy,
  QueryCtx,
  ReadWrite,
  Registered,
  RegisteredCron,
  RegisteredEvent,
  RegisteredFn,
  RegisteredListener,
  Registry,
  RegistryOptions,
  RunArgs,
  RunJob,
  RunJobOptions,
  RunOptions,
  Runner,
  ScheduleOptions,
  Schema,
  SweepResult,
} from "./types.ts";
export { DomainError, isDomainError, type ErrorKind } from "./errors.ts";
export { inProcess, replaceKeyOf } from "./jobs.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * init: typed constructors
 * ──────────────────────────────────────────────────────────────────────────── */

type TypedOptions<C extends Config, Mods extends Record<string, object>, T> = Omit<RegistryOptions<Mods>, "wrap" | "jobs"> & {
  /** Background work: `jobs: { adapter: databaseQueue(db), scope: { store, load } }`. Default: in-process, scope as-is (nothing waits). */
  jobs?: JobsOptions<ScopeOf<C>, T>;
  /** Wraps every call, including ones that fail validation or authorization: logging, tracing, audit. */
  wrap?: (call: Call<CallMetaOf<C>>, next: () => Promise<unknown>) => Promise<unknown>;
} &
  ({} extends ServicesOf<C> ? { services?: ServicesOf<C> } : { services: ServicesOf<C> }) &
  ({} extends ConfigOf<C> ? { config?: ConfigOf<C> } : { config: ConfigOf<C> }) &
  ([DbOf<C>] extends [never] ? { database?: undefined } : { database: DatabaseAdapter<unknown, DbOf<C>> });

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
  // One implementation behind the typed signature of `Constructor`; `checkExposure` is the runtime half that matters.
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
     * Run a function on a schedule, as `scope` (a cron has no caller). Export it from a module, like listeners, and call
     * `registry.jobs.tick()` every minute (or from your platform's cron trigger):
     * `cron({ schedule: "0 9 * * 1", run: reports.sendWeekly, scope: system })`.
     */
    cron: <F extends Fn>(def: CronDef<ScopeOf<C>, F>): Cron => {
      const { id, schedule, timezone, run, input, scope, attempts } = def;
      parseSchedule(schedule);
      if (timezone !== undefined) assertTimeZone(timezone);
      checkAttempts("cron", attempts);
      return Object.freeze({ [BRAND]: "cron" as const, kind: "cron" as const, id, schedule, timezone, run, input, scope, attempts });
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
       * Once they're used, the job is `failed` (kept by `databaseQueue`, `outbox` and pg-boss, retried with `registry.jobs.retry(id)`).
       */
      attempts?: number;
      /** Seconds after the event before the first try. Needs an adapter that holds jobs: `inProcess()` is refused. */
      delay?: number;
      meta?: ListenerMetaOf<C>;
      handler: (ctx: ListenerCtx<C, O>, payload: O) => Promise<unknown>;
    }): Listener<O> => {
      const { id, event, attempts, delay, meta, handler } = def;
      checkAttempts("listener", attempts);
      if (delay !== undefined && !(Number.isFinite(delay) && delay >= 0))
        throw new Error(`[logic-sdk] listener delay must be seconds, 0 or more (got ${delay}).`);
      // meta is checked against ListenerMetaOf<C> above and stored loose, like Fn.meta, for wrap and adapters
      return Object.freeze({ [BRAND]: "listener" as const, kind: "listener" as const, id, event, attempts, delay, meta: meta as Listener["meta"], handler });
    },
  };
}

/** `cron({...})`: `input` is required exactly when the function needs one. */
type CronDef<S, F extends Fn> = {
  /** Stable id, local to its module, like every definer's. Defaults to the export name. */
  id?: string;
  /** Five fields: minute hour day-of-month month day-of-week. `"*\/15 * * * *"`, `"0 9 * * 1"`. */
  schedule: string;
  /** IANA name, like `"Europe/Madrid"`. Default UTC. Matched on the wall clock, like Laravel: mind DST at 1 to 3 am. */
  timezone?: string;
  /** Any query, mutation or action: it runs with its policy, validation and tracing. */
  run: F;
  /** Who it runs as: a cron has no caller. */
  scope: S;
  /** Tries in total, like a listener's. Default 1. */
  attempts?: number;
} & (undefined extends FnIn<F> ? { input?: FnIn<F> } : { input: FnIn<F> });

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
  events: Envelope[];
  /** What `ctx.schedule` asked for, enqueued with the events at commit. */
  calls: CallJob[];
  pending: Promise<void>[];
}
interface Frame {
  scope: object;
  depth: number;
  /** Inherited, for actions to pass on as ctx.signal. */
  signal?: AbortSignal;
  /** Passed to this very call: checked before it starts. */
  abortOn?: AbortSignal;
  eventDepth?: number;
  tx?: TxState;
}

/** Create the registry once at startup. Prefer the `createRegistry` returned by `init()`: it's typed with your config. */
export function createRegistry<S extends object = object, const Mods extends Record<string, object> = Record<string, object>>(
  options: RegistryOptions<Mods>,
) {
  return build<S, Mods>(options, {});
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Plain objects merge key by key; anything else (values, arrays, null) replaces. `undefined` keeps the base. */
function mergeConfig(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlain(base) || !isPlain(patch)) return patch;
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
      if (!isPlain(v)) fail(`a ${v.constructor?.name ?? "class instance"}`);
      for (const [k, item] of Object.entries(v)) check(item, path ? `${path}.${k}` : k);
    }
    seen.delete(v);
  };
  check(value, "");
}

const isBranded = (v: unknown): v is Fn | EventDef | Listener | Cron => !!v && typeof v === "object" && BRAND in v;

/**
 * Publishing needs `authorize` and `output`. The types say so; this holds for JS callers and casts too, because an
 * exposed function nobody authorizes is a hole, not a type error.
 */
function checkExposure(id: string, fn: Fn) {
  if (fn.expose && !fn.authorize) throw new Error(`[logic-sdk] ${id} has expose: true but no authorize. Say who may call it.`);
  if (fn.expose && !fn.output) throw new Error(`[logic-sdk] ${id} has expose: true but no output. Say what callers may see.`);
}

/**
 * What `createRegistry` finds in your modules, without a database or services: every function, event and
 * listener with its id. For tools (the CLI, docs generators) that inspect an app without running it.
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
      else {
        checkExposure(id, value);
        functions.push({ id, module, name, kind: value.kind, fn: value, exposed: value.expose === true });
      }
    }
  }
  return { ids, functions, events, listeners, crons };
}

function build<S extends object, Mods extends Record<string, object>, Cf = unknown>(
  options: RegistryOptions<Mods>,
  o: Overrides,
): Registry<S, Mods, Cf> {
  const { ids, functions, events, listeners, crons } = describeModules(options.modules);

  const database = o.database ?? options.database;
  const services = o.services ?? options.services ?? {};
  const config = freezeConfig(mergeConfig(options.config ?? {}, o.config)) as Frozen<Cf>;
  const dispatcher = o.adapter ?? options.jobs?.adapter ?? inProcess();
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
  const maxEventDepth = options.maxEventDepth ?? 8;
  const transactionAttempts = Math.max(1, database?.transactionAttempts ?? 3);
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

  if (functions.some((f) => f.kind === "mutation") && database?.transactions !== "interactive")
    throw new Error(
      "[logic-sdk] Mutations need a database adapter with interactive transactions (e.g. drizzleAdapter(db)). " +
        "Drivers without them (Cloudflare D1, HTTP drivers) are not supported for mutations.",
    );
  for (const l of listeners)
    if (!ids.has(l.event))
      throw new Error(`[logic-sdk] Listener ${l.id} listens to an event that isn't registered in any module.`);
  dispatcher.check?.({ listeners, database });

  const idOf = (x: object) => {
    const id = ids.get(x);
    if (!id)
      throw new Error(
        "[logic-sdk] This function or event isn't registered. Export it from its module's index.ts, and add the module to createRegistry({ modules }).",
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
  function checkAtCommit(tx: TxState, schema: Schema, value: unknown, what: string) {
    const check = parseOwn(schema, value, what).then(() => {});
    check.catch(() => {}); // surfaced at commit; never an unhandled rejection
    tx.pending.push(check);
  }

  for (const c of crons) {
    if (!ids.has(c.cron.run))
      throw new Error(`[logic-sdk] Cron ${c.id} runs a function that isn't registered. Export it from its module's index.ts.`);
    assertPlain(c.cron.input, `${c.id} input`, "Cron runs travel through queues as JSON: send an ISO string and let the schema turn it into a Date");
  }

  // ── ctx ──────────────────────────────────────────────────────────────────
  /** The frame a call runs in: one level deeper, with this call's scope patch and signal. */
  const enter = (frame: Frame, options: RunOptions | undefined): Frame => ({
    ...frame,
    depth: frame.depth + 1,
    scope: options?.scope ? { ...frame.scope, ...options.scope } : frame.scope,
    signal: options?.signal ?? frame.signal,
    abortOn: options?.signal,
  });

  /** What every ctx has. `allowed`: the kinds its `run` may call. */
  const baseCtx = (frame: Frame, id: string, allowed: Kind[]) => ({
    errors: errorsFor(id),
    scope: frame.scope,
    config: config as any, // Frozen<Cf> here; each app's ctx types it from its own Config
    now,
    run: (fn: Fn, input?: unknown, options?: RunOptions) => invoke(fn, input, enter(frame, options), allowed),
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
        const envelope = envelopeOf(event, payload, frame.scope, (frame.eventDepth ?? 0) + 1);
        tx.events.push(envelope);
        checkAtCommit(tx, event.payload, envelope.payload, `${envelope.name} payload`);
      },
      schedule: (fn, input, { at, delay, attempts = 1, replace }) => {
        const fnId = idOf(fn);
        const seconds = at ? (at.getTime() - now().getTime()) / 1000 : (delay ?? NaN);
        if (!Number.isFinite(seconds) || (!at && seconds < 0))
          throw new Error(`[logic-sdk] ctx.schedule(${fnId}) needs an \`at\` date or a \`delay\` in seconds, 0 or more.`);
        checkAttempts(`ctx.schedule(${fnId})`, attempts);
        if (replace !== undefined) {
          if (!replace) throw new Error(`[logic-sdk] ctx.schedule(${fnId}) replace must be a non-empty key.`);
          if (!dispatcher.replaces)
            throw new Error(`[logic-sdk] ctx.schedule(${fnId}) replaces a waiting call, but your jobs adapter can't replace one it already has. Use databaseQueue(db), or outbox(db, queue) in front of your queue.`);
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
          scope: storedScope(frame.scope, `the scope scheduling ${fnId}`),
          attempts,
          depth: waits ? 0 : (frame.eventDepth ?? 0) + 1, // due now, it's the next hop of this chain; a real wait starts a new one
        };
        if (waits) job.runAt = new Date(now().getTime() + seconds * 1000).toISOString();
        if (replace !== undefined) {
          job.replace = replace;
          // scheduled twice in this transaction: the later one wins here too (the dropped one's input is still checked:
          // a bad input is a bug wherever it is)
          const earlier = tx.calls.findIndex((c) => replaceKeyOf(c) === replaceKeyOf(job));
          if (earlier >= 0) tx.calls.splice(earlier, 1);
        }
        tx.calls.push(job);
        // our own code passed it: a bad input is a bug, surfaced at commit like an event's payload
        if (fn.input) checkAtCommit(tx, fn.input, job.input, `${fnId} input`);
        return job.id;
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

  const { toJobs, runner, jobs, due, checkHold, reportEach } = makeJobs({
    listeners,
    events,
    crons,
    functions,
    idOf,
    dispatcher,
    database,
    jobScope,
    maxEventDepth,
    now,
    wrap,
    report,
    runAs: (fn, input, scope, eventDepth) => invoke(fn, input, enter({ scope, depth: -1, eventDepth }, undefined), ["query", "mutation", "action"]),
    listenerCtx: (scope, eventDepth, id) => actionCtx({ scope, depth: 0, eventDepth }, id),
  });

  // ── invoke ───────────────────────────────────────────────────────────────
  async function invoke(fn: Fn, rawInput: unknown, frame: Frame, allowed: Kind[]): Promise<any> {
    const id = idOf(fn);
    if (!allowed.includes(fn.kind))
      throw new Error(`[logic-sdk] ${id} is a ${fn.kind}; it can't be run from here (allowed: ${allowed.join(", ")}).`);

    const call: Call = { id, kind: fn.kind, meta: fn.meta, input: rawInput, scope: frame.scope, depth: frame.depth };

    /** Authorize, then validate, before any transaction opens: denied or bad calls never touch the database. */
    const prepare = async () => {
      frame.abortOn?.throwIfAborted();
      if (fn.authorize) {
        // SAFETY: the registry erases each policy's scope type; the caller's scope is the app's Scope by construction
        if (fn.authorize(frame.scope as never) !== true) throw new DomainError("forbidden", `${id}.forbidden`);
      }
      // no `input`: the function takes nothing, whatever an adapter sends (AI tools send `{}`)
      return fn.input ? parseInput(fn.input, rawInput, id, frame.depth > 0) : undefined;
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
          }
          throw e;
        }
      }

      // top-level mutation: open the transaction, commit, then deliver events.
      // A lost race (deadlock, serialization failure) re-runs it in a fresh transaction.
      const input = await prepare();
      let committed: { out: unknown; events: Envelope[]; jobs: Job[] };
      for (let attempt = 1; ; attempt++) {
        try {
          // SAFETY: createRegistry refuses mutations without a database that has interactive transactions
          committed = await database!.transaction(async (txDb) => {
            // fresh per attempt, so a retry never reuses events from a failed attempt
            const tx: TxState = { db: txDb, doomed: false, reason: undefined, events: [], calls: [], pending: [] };
            const out = await execute(input, mutationCtx({ ...frame, tx }, tx, id));
            await Promise.all(tx.pending);
            if (tx.doomed) throw tx.reason;
            const jobs = toJobs(tx.events, tx.calls);
            if (jobs.length) await dispatcher.enqueue?.(txDb, jobs);
            return { out, events: tx.events, jobs };
          });
          break;
        } catch (e) {
          if (attempt < transactionAttempts && database!.retryable?.(e)) { // SAFETY: as above
            // a random pause, so transactions that just deadlocked don't retry in lockstep and collide again
            await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
            continue;
          }
          throw e;
        }
      }

      // committed. Nothing below may fail the caller.
      await afterCommit(committed.events, committed.jobs);
      return committed.out;
    });
  }

  async function afterCommit(emitted: Envelope[], jobs: Job[]) {
    try {
      for (const e of emitted) o.record?.(e);
      if (!jobs.length) return;
      const delivery = dispatcher.deliver(jobs, runner).catch((e) => reportEach(e, jobs));
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
    modules: options.modules,
    as: (scope) => ({
      scope,
      run: (fn: Fn, input?: unknown, options?: RunOptions) =>
        invoke(fn, input, enter({ scope, depth: -1 }, options), ["query", "mutation", "action"]), // depth 0
    }),
    definitions: { functions, events, listeners, crons },
    idOf,
    jobs,
    [INTERNAL]: {
      options,
      config,
      derive: (more: Overrides) => build<S, Mods, Cf>(options, { ...o, ...more, config: mergeConfig(o.config, more.config) }),
      envelope: (event, payload, scope) => envelopeOf(event, payload, scope, 1),
      due,
    },
  };
}

/** @internal */
export const internal = <S extends object, Mods extends Record<string, object>, Cf>(registry: Registry<S, Mods, Cf>) => registry[INTERNAL];
