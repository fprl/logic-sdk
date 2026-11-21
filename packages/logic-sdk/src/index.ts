import { describeIssues, DomainError, errorsFor } from "./errors.ts";
import { inProcess, makeJobs } from "./jobs.ts";
import { assertTimeZone, parseSchedule } from "./schedule.ts";
import { BRAND, INTERNAL } from "./types.ts";
import type {
  ActionCtx,
  Call,
  Config,
  ConfigOf,
  Constructor,
  Cron,
  DatabaseAdapter,
  DbOf,
  Delivery,
  Envelope,
  EventDef,
  FailureInfo,
  Fn,
  FnIn,
  Frozen,
  In,
  JobsOptions,
  Kind,
  Listener,
  ListenerCtx,
  MetaOf,
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
  Caller,
  Config,
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
  Frozen,
  Job,
  JobScope,
  Jobs,
  JobsOptions,
  Kind,
  Listener,
  ListenerCtx,
  ListenerEvent,
  MutationCtx,
  Overrides,
  Policy,
  QueryCtx,
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
  SweepResult,
} from "./types.ts";
export { DomainError, isDomainError, type ErrorKind } from "./errors.ts";
export { inProcess } from "./jobs.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * init: typed constructors
 * ──────────────────────────────────────────────────────────────────────────── */

type TypedOptions<C extends Config, Mods extends Record<string, object>, T> = Omit<RegistryOptions<Mods>, "wrap" | "jobs"> & {
  /** Background work: `jobs: { adapter: outbox(db), scope: { store, load } }`. Default: in-process, scope as-is. */
  jobs?: JobsOptions<ScopeOf<C>, T>;
  /** Wraps every call, including ones that fail validation or authorization: logging, tracing, audit. */
  wrap?: (call: Call<MetaOf<C>>, next: () => Promise<unknown>) => Promise<unknown>;
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
    (def: any): any =>
      Object.freeze({ [BRAND]: kind, kind, ...def });

  return {
    /** Create the registry once at startup: `createRegistry({ modules, database, services })`. */
    createRegistry: <const Mods extends Record<string, object>, T = ScopeOf<C>>(options: TypedOptions<C, Mods, T>) =>
      build<ScopeOf<C>, Mods, ConfigOf<C>>(options as RegistryOptions<Mods>, {}), // meta in wrap is typed by MetaOf<C>; the values come from typed defs
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
      const { id, schedule, timezone, run, scope, attempts } = def;
      const input = "input" in def ? def.input : undefined;
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
       * Once they're used, the job is `failed` (kept by the outbox, retried with `registry.jobs.retry(id)`).
       */
      attempts?: number;
      /** Seconds after the event before the first try. `inProcess()` ignores it, like Laravel's sync queue. */
      delay?: number;
      meta?: MetaOf<C>;
      handler: (ctx: ListenerCtx<C, O>, payload: O) => Promise<unknown>;
    }): Listener<O> => {
      const { id, event, attempts, delay, meta, handler } = def;
      checkAttempts("listener", attempts);
      if (delay !== undefined && !(Number.isFinite(delay) && delay >= 0))
        throw new Error(`[logic-sdk] listener delay must be seconds, 0 or more (got ${delay}).`);
      // meta is checked against your MetaOf<C> above and stored loose, like Fn.meta, for wrap and adapters
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
  outbox: Envelope[];
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
    if (typeof v !== "object") fail(`a ${typeof v}`);
    const obj = v as object;
    if (seen.has(obj)) fail("a circular reference");
    seen.add(obj);
    if (Array.isArray(obj)) obj.forEach((item, i) => check(item, `${path}[${i}]`));
    else {
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) fail(`a ${obj.constructor?.name ?? "class instance"}`);
      for (const [k, item] of Object.entries(obj)) check(item, path ? `${path}.${k}` : k);
    }
    seen.delete(obj);
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
  const enqueue = dispatcher.enqueue?.bind(dispatcher);
  const jobScope = options.jobs?.scope;
  if (jobScope?.store && !jobScope.load) throw new Error("[logic-sdk] jobs.scope has store but no load. Listeners run as a scope, so rebuild it from what store saved.");
  const now = o.now ?? options.now ?? (() => new Date());
  const wrap = options.wrap ?? ((_c, next) => next());
  const maxEventDepth = options.maxEventDepth ?? 8;
  const attempts = Math.max(1, options.retry?.attempts ?? 3);
  const waitUntil = "waitUntil" in o ? o.waitUntil : options.waitUntil; // tests turn it off: listeners finish inside the test
  const reportRaw =
    o.onError ?? options.onError ?? ((e, info) => console.error(`[logic-sdk] ${info.listener} failed`, e));
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
    if (!l.event || !ids.has(l.event))
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
  function mutationCtx(frame: Frame, id: string): MutationCtx<any> {
    const tx = frame.tx!;
    return {
      ...baseCtx(frame, id, ["query", "mutation"]),
      db: tx.db,
      emit: (event, payload) => {
        // reserve the slot now so events keep emit order, even with async schemas
        const envelope = envelopeOf(event, payload, frame.scope, (frame.eventDepth ?? 0) + 1);
        tx.outbox.push(envelope);
        const check = parseOwn(event.payload, envelope.payload, `${envelope.name} payload`).then(() => {});
        check.catch(() => {}); // surfaced at commit; never an unhandled rejection
        tx.pending.push(check);
      },
    };
  }
  /** An emitted event as jobs carry it: plain JSON, and copied, so what was emitted is what gets delivered. */
  function envelopeOf(event: EventDef, payload: unknown, scope: object, depth: number): Envelope {
    const name = idOf(event);
    // a queue carries JSON: a Date or a class instance would work in-process and break only in production
    assertPlain(payload, `${name} payload`, "Events travel through queues as JSON: send an ISO string and let the schema turn it into a Date");
    const stored = jobScope?.store ? jobScope.store(scope) : scope;
    assertPlain(stored, `the scope emitting ${name}`, "Events carry the scope through queues as JSON: keep it to ids (jobs.scope.store picks what's saved)");
    return { id: crypto.randomUUID(), name, payload: structuredClone(payload), scope: structuredClone(stored), occurredAt: now().toISOString(), depth };
  }

  const actionCtx = (frame: Frame, id: string): ActionCtx<any> => ({
    ...baseCtx(frame, id, ["query", "mutation", "action"]),
    signal: frame.signal,
    services,
  });

  const { toDeliveries, runner, jobs, due } = makeJobs({
    listeners,
    events,
    crons,
    idOf,
    dispatcher,
    database,
    jobScope,
    maxEventDepth,
    now,
    wrap,
    report,
    runAs: (fn, input, scope) => invoke(fn, input, enter({ scope, depth: -1 }, undefined), ["query", "mutation", "action"]),
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
          return await execute(await prepare(), mutationCtx(frame, id));
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
      let committed: { out: unknown; outbox: Envelope[]; deliveries: Delivery[] };
      for (let attempt = 1; ; attempt++) {
        let state: TxState | undefined;
        try {
          committed = await database!.transaction(async (txDb) => {
            // fresh per attempt, so a retry never reuses events from a failed attempt
            const tx: TxState = (state = { db: txDb, doomed: false, reason: undefined, outbox: [], pending: [] });
            const out = await execute(input, mutationCtx({ ...frame, tx }, id));
            await Promise.all(tx.pending);
            if (tx.doomed) throw tx.reason;
            const deliveries = toDeliveries(tx.outbox);
            if (deliveries.length) await enqueue?.(txDb, deliveries);
            return { out, outbox: tx.outbox, deliveries };
          });
          break;
        } catch (e) {
          if (attempt < attempts && database!.retryable?.(e)) {
            // a random pause, so transactions that just deadlocked don't retry in lockstep and collide again
            await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
            continue;
          }
          throw e;
        } finally {
          if (state) await Promise.allSettled(state.pending);
        }
      }

      // committed. Nothing below may fail the caller.
      if (committed.outbox.length) await afterCommit(committed.outbox, committed.deliveries);
      return committed.out;
    });
  }

  async function afterCommit(outbox: Envelope[], deliveries: Delivery[]) {
    try {
      for (const e of outbox) o.record?.(e);
      if (!deliveries.length) return;
      const delivery = (async () => dispatcher.deliver(deliveries, runner))().catch((e) =>
        report(e, { listener: "(dispatcher)", envelope: outbox[0] }),
      );
      if (waitUntil) {
        try {
          waitUntil(delivery);
          return;
        } catch (e) {
          report(e, { listener: "(waitUntil)", envelope: outbox[0] });
        }
      }
      await delivery;
    } catch (e) {
      report(e, { listener: "(after commit)", envelope: outbox[0] });
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
      derive: (more: Overrides) => build<S, Mods, Cf>(options, { ...o, ...more, config: mergeConfig(o.config, more.config) as object | undefined }),
      envelope: (event, payload, scope) => envelopeOf(event, payload, scope, 1),
      due,
    },
  };
}

/** @internal */
export const internal = <S extends object, Mods extends Record<string, object>, Cf>(registry: Registry<S, Mods, Cf>) => registry[INTERNAL];
