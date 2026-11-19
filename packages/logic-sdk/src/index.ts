import type { StandardSchemaV1 } from "@standard-schema/spec";

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

type Schema<I = any, O = any> = StandardSchemaV1<I, O>;
type In<S> = S extends Schema<infer I, any> ? I : never;
type Out<S> = S extends Schema<any, infer O> ? O : never;
type Awaitable<T> = T | Promise<T>;

/** What you declare once in `init<...>()`. */
export interface Config {
  /** Who and where: actor, account, locale... Must be JSON-serializable (it travels with events). */
  scope: object;
  /** The transaction handle mutations receive (e.g. a Drizzle transaction). */
  db?: unknown;
  /** What queries receive. Defaults to `db`. Use a read-only type (e.g. `DrizzleReader<Tx>`). */
  reader?: unknown;
  /** Side-effecting services (mailer, payments...). Only actions and listeners receive them. */
  services?: object;
  /** The shape of `meta` on your functions (tags, rate limits, "agent may call"...). Read by `wrap` and adapters. */
  meta?: object;
}
type ScopeOf<C extends Config> = C["scope"];
type DbOf<C extends Config> = C extends { db: infer D } ? D : never;
type ReaderOf<C extends Config> = C extends { reader: infer R } ? R : DbOf<C>;
type ServicesOf<C extends Config> = C extends { services: infer S } ? S : {};
type MetaOf<C extends Config> = C extends { meta: infer M } ? M : never;

export type Kind = "query" | "mutation" | "action";

declare const types: unique symbol;
const BRAND: unique symbol = Symbol.for("logic-sdk.brand") as any;

/** A query, mutation or action. Call it with `caller.run(fn, input)` or `ctx.run(fn, input)`. */
export interface Fn<K extends Kind = Kind, I = any, O = any, E extends boolean = boolean> {
  readonly [BRAND]: K;
  readonly kind: K;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly outputSchema?: Schema;
  /** Your own data about the function. Checked against `meta` in `init` where you set it, typed in `wrap`; loose here, for adapters. */
  readonly meta?: any;
  /** Set when the function is exposed: who may call it. Runs on every call. */
  readonly check?: (scope: any, input: any) => Awaitable<boolean>;
  readonly execute: (input: any, ctx: any) => Promise<any>;
  /** Phantom types, never set at runtime. */
  readonly [types]?: { input: I; output: O; exposed: E };
}
/** A function with `expose`: adapters publish it. */
export type ExposedFn<K extends Kind = Kind, I = any, O = any> = Fn<K, I, O, true>;
/** What callers pass to a function. */
export type FnIn<F> = F extends Fn<any, infer I, any> ? I : never;
/** What a function returns. */
export type FnOut<F> = F extends Fn<any, any, infer O> ? O : never;

/** `I`: what `emit` takes. `O`: what listeners receive (after the schema's transforms and defaults). */
export interface EventDef<I = any, O = I> {
  readonly [BRAND]: "event";
  readonly kind: "event";
  readonly schema: Schema;
  readonly description?: string;
  readonly [types]?: { input: I; payload: O };
}

/**
 * What a dispatcher stores and delivers. Fully JSON: `payload` is what was emitted (validated),
 * and listeners get it parsed again by the event's schema at delivery.
 */
export interface Envelope<P = unknown, S = object> {
  id: string;
  name: string;
  payload: P;
  scope: S;
  occurredAt: string;
}

export interface Listener<O = any> {
  readonly [BRAND]: "listener";
  readonly kind: "listener";
  /** Lazy, so listeners can import other modules' barrels without import cycles. */
  readonly event: () => EventDef<any, O>;
  readonly description?: string;
  readonly execute: (payload: O, ctx: any) => Promise<unknown>;
}

type Run<Allowed extends Kind> = <F extends Fn<Allowed>>(fn: F, input: FnIn<F>) => Promise<FnOut<F>>;

/**
 * Expected failures, namespaced to the module you're in: inside `bookings`, `ctx.reject("not_pending")` has
 * code `"bookings.not_pending"`. Throw what they return. Codes are plain strings on purpose (see the errors docs).
 */
interface Fail {
  /** A business rule said no, and trying again won't help. `throw ctx.reject("not_pending", { status })` */
  reject(code: string, details?: unknown): DomainError;
  /** Someone else got there first, or it already exists. Refreshing and retrying may work. */
  conflict(code: string, details?: unknown): DomainError;
  /** It doesn't exist, or isn't visible in this scope. Code defaults to `"<module>.not_found"`. */
  notFound(code?: string, details?: unknown): DomainError;
  /** The caller is known but may not do this. Code defaults to `"<module>.<function>.forbidden"`. */
  deny(code?: string, details?: unknown): DomainError;
}
interface BaseCtx<S> extends Fail {
  scope: S;
  /** Current time. Fixed in tests. */
  now: () => Date;
}
/** `S` is the scope, narrowed by the function's policy. Alias it in init.ts: `type QueryCtx = Core.QueryCtx<Config>`. */
export interface QueryCtx<C extends Config, S = ScopeOf<C>> extends BaseCtx<S> {
  db: ReaderOf<C>;
  run: Run<"query">;
  /** The caller's abort signal, if any. */
  signal: AbortSignal | undefined;
  with(patch: Partial<ScopeOf<C>>): QueryCtx<C>;
}
export interface MutationCtx<C extends Config, S = ScopeOf<C>> extends BaseCtx<S> {
  db: DbOf<C>;
  run: Run<"query" | "mutation">;
  /** Queue an event. Delivered to listeners only after the transaction commits. */
  emit<I>(event: EventDef<I, any>, payload: I): void;
  signal: AbortSignal | undefined;
  with(patch: Partial<ScopeOf<C>>): MutationCtx<C>;
}
export interface ActionCtx<C extends Config, S = ScopeOf<C>> extends BaseCtx<S> {
  services: ServicesOf<C>;
  /** Each mutation you run here gets its own transaction. */
  run: Run<Kind>;
  /** The caller's abort signal. Always undefined in listeners (they outlive the request). */
  signal: AbortSignal | undefined;
  with(patch: Partial<ScopeOf<C>>): ActionCtx<C>;
}
export interface ListenerCtx<C extends Config, O = unknown> extends ActionCtx<C> {
  event: Envelope<unknown, ScopeOf<C>> & { payload: O };
}

/** Who may call an exposed function. Write it as a type guard (`(s): s is Staff => ...`) to narrow `scope` in `execute`. */
export type Policy<S> = (scope: S) => boolean;
type Guarded<F, S> = F extends (scope: any) => scope is infer G ? G : S;
type Inline<C extends Config, IS extends Schema> = (scope: ScopeOf<C>, input: Out<IS>) => Awaitable<boolean>;
/** A policy name from `init`, or an inline check that also sees the input. */
type Exposure<C extends Config, P, IS extends Schema> = (keyof P & string) | Inline<C, IS>;
type ScopeFor<C extends Config, P, E> = E extends keyof P ? Guarded<P[E], ScopeOf<C>> : ScopeOf<C>;
type CtxOf<C extends Config, K extends Kind, S> = K extends "query"
  ? QueryCtx<C, S>
  : K extends "mutation"
    ? MutationCtx<C, S>
    : ActionCtx<C, S>;

type Def<IS extends Schema, Ctx, R> = {
  /** One sentence, shown to humans, adapters and AI tools. */
  description: string;
  inputSchema: IS;
  execute: (input: Out<IS>, ctx: Ctx) => Promise<R>;
};
type Internal = { expose?: undefined };
type WithMeta<C extends Config> = { meta?: MetaOf<C> };
type WithOutput<OS extends Schema> = { outputSchema: OS };

/** Exposed functions must declare `outputSchema`: what leaves your process is a contract. Internal ones may skip it. */
interface Constructor<C extends Config, K extends Kind, P> {
  <IS extends Schema, OS extends Schema, const E extends Exposure<C, P, IS>>(
    def: Def<IS, CtxOf<C, K, ScopeFor<C, P, E>>, In<OS>> & WithOutput<OS> & WithMeta<C> & { expose: E },
  ): Fn<K, In<IS>, Out<OS>, true>;
  <IS extends Schema, OS extends Schema>(
    def: Def<IS, CtxOf<C, K, ScopeOf<C>>, In<OS>> & WithOutput<OS> & WithMeta<C> & Internal,
  ): Fn<K, In<IS>, Out<OS>, false>;
  <IS extends Schema, R>(def: Def<IS, CtxOf<C, K, ScopeOf<C>>, R> & WithMeta<C> & Internal): Fn<K, In<IS>, R, false>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Errors
 * ──────────────────────────────────────────────────────────────────────────── */

export type ErrorKind = "invalid" | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "rejected";

/**
 * An expected failure: a `kind` (a small fixed set), a namespaced `code` and optional `details`. No HTTP here;
 * adapters map kinds to statuses. Anything else thrown (including invalid output or event payloads, which are
 * bugs) is unexpected: adapters answer 500 and report it.
 */
export class DomainError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly details: unknown;
  constructor(kind: ErrorKind, code: string, details?: unknown) {
    // the details are in the message too: logs and AI tool errors (which show only the message) stay useful
    super(details === undefined ? code : `${code} ${JSON.stringify(details)}`);
    this.name = "DomainError";
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}
/** For the edge (`resolveScope`): no valid session. Inside modules, use `ctx.deny()`. */
export const unauthenticated = (code = "unauthenticated", details?: unknown) =>
  new DomainError("unauthenticated", code, details);
/** `isDomainError(e)`, or with a code: `isDomainError(e, "availability.dates_unavailable")`. */
export const isDomainError = (e: unknown, code?: string): e is DomainError =>
  e instanceof DomainError && (code === undefined || e.code === code);

/** `ctx.reject` and friends for one function or listener (`id` like "bookings.confirm"). */
const failFor = (id: string): Fail => {
  const module = id.slice(0, id.indexOf("."));
  return {
    reject: (code, details) => new DomainError("rejected", `${module}.${code}`, details),
    conflict: (code, details) => new DomainError("conflict", `${module}.${code}`, details),
    notFound: (code = "not_found", details) => new DomainError("not_found", `${module}.${code}`, details),
    deny: (code, details) => new DomainError("forbidden", code ? `${module}.${code}` : `${id}.forbidden`, details),
  };
};

/* ────────────────────────────────────────────────────────────────────────────
 * Adapters and dispatcher seams
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DatabaseAdapter<Db = unknown, Tx = Db> {
  /** Root handle, used by top-level queries. */
  readonly db: Db;
  readonly transactions: "interactive";
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** An adapter bound to an existing transaction (nested transactions become savepoints). Used by the test helper. */
  nest?(tx: Tx): DatabaseAdapter<Tx, Tx>;
  /** Did this transaction lose a race the database says to retry (deadlock, serialization failure)? */
  retryable?(error: unknown): boolean;
}

export interface Dispatcher {
  /** Inside the transaction, before commit. In-process: nothing. Outbox: insert rows with `tx`. */
  enqueue?(tx: unknown, envelopes: Envelope[]): Promise<void>;
  /** After commit. `dispatch` runs the listeners for one envelope and never throws (failures go to `onError`). */
  deliver(envelopes: Envelope[], dispatch: (envelope: Envelope) => Promise<void>): Promise<void>;
}

/** Default dispatcher: delivers right after commit, in this process. Lost on crash: use an outbox when that matters. */
export const inProcess = (): Dispatcher => ({
  async deliver(envelopes, dispatch) {
    for (const e of envelopes) await dispatch(e);
  },
});

export interface Call<M = unknown> {
  id: string;
  kind: Kind | "listener";
  /** The function's `meta` (undefined for listeners and functions without it). */
  meta: M | undefined;
  /** Raw input as received (before validation). */
  input: unknown;
  scope: object;
  depth: number;
}

export interface RegistryOptions<Mods extends Record<string, object>> {
  /** One entry per module: `{ bookings, availability }` with `import * as bookings from "./bookings"`. */
  modules: Mods;
  database?: DatabaseAdapter<any, any>;
  services?: object;
  events?: Dispatcher;
  /** Wraps every call, including ones that fail validation or authorization: logging, tracing, audit. */
  wrap?: (call: Call, next: () => Promise<unknown>) => Promise<unknown>;
  /**
   * Serverless: let listeners finish after the response. Pass the platform's global:
   * `import { waitUntil } from "cloudflare:workers"` or `import { waitUntil } from "@vercel/functions"`.
   * Without it, `run` waits for listeners, which is what tests and long-lived servers want.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Failures after commit land here (listeners, dispatcher). They never fail the caller. */
  onError?: (error: unknown, info: { listener: string; envelope: Envelope | undefined }) => void;
  now?: () => Date;
  /** Max chain of listener → mutation → event → listener… before delivery stops. Default 8 (real chains are 2 or 3). */
  maxEventDepth?: number;
  /**
   * Re-run a top-level mutation in a fresh transaction when the database says it lost a race (deadlock,
   * serialization failure). Safe because mutations have no side effects and events are rebuilt per attempt.
   * Default 3 attempts in total; `{ attempts: 1 }` turns it off.
   */
  retry?: { attempts?: number };
}

export interface CallerOptions {
  /** Aborts the call before it starts work. Listeners never get it: they outlive the request. */
  signal?: AbortSignal;
}

/** A registry bound to a scope: `const caller = registry.as(scope)`. */
export interface Caller<S extends object = object> {
  readonly scope: S;
  run<F extends Fn>(fn: F, input: FnIn<F>): Promise<FnOut<F>>;
  with(patch: Partial<S>): Caller<S>;
}

export interface Registered {
  id: string;
  module: string;
  name: string;
}
export interface RegisteredFn extends Registered {
  fn: Fn;
  kind: Kind;
  /** Has `expose`: adapters publish it. */
  exposed: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * init: typed constructors
 * ──────────────────────────────────────────────────────────────────────────── */

type TypedOptions<C extends Config, Mods extends Record<string, object>> = Omit<RegistryOptions<Mods>, "wrap"> & {
  /** Wraps every call, including ones that fail validation or authorization: logging, tracing, audit. */
  wrap?: (call: Call<MetaOf<C>>, next: () => Promise<unknown>) => Promise<unknown>;
} &
  ({} extends ServicesOf<C> ? { services?: ServicesOf<C> } : { services: ServicesOf<C> }) &
  ([DbOf<C>] extends [never] ? { database?: undefined } : { database: DatabaseAdapter<any, DbOf<C>> });

/**
 * Typed constructors for your app. Curried so policy names are inferred while `Config` is explicit:
 *
 * ```ts
 * export const { query, mutation, action, event, on, createRegistry } = init<Config>()({
 *   policies: { public: () => true, staff: (s): s is Staff => isStaff(s) },
 * });
 * ```
 */
/** Keys `Config` doesn't know are errors, so a typo like `servises` can't be silently ignored. */
type OnlyKnownKeys<C> = { [K in Exclude<keyof C, keyof Config>]: never };

export function init<C extends Config & OnlyKnownKeys<C>>(): Init<C> {
  return ((options?: { policies?: Record<string, Policy<any>> }) => constructors<C, {}>(options?.policies ?? {})) as Init<C>;
}

interface Init<C extends Config> {
  (): Constructors<C, {}>;
  <P extends Record<string, Policy<ScopeOf<C>>>>(options: { policies: P }): Constructors<C, P>;
}
type Constructors<C extends Config, P> = ReturnType<typeof constructors<C, P>>;

function constructors<C extends Config, P>(policies: Record<string, Policy<any>>) {
  const make =
    <K extends Kind>(kind: K) =>
    ({ expose, ...def }: any): any => {
      let check: Fn["check"];
      if (typeof expose === "function") check = expose;
      else if (expose !== undefined) {
        check = policies[expose];
        if (!check) throw new Error(`[logic-sdk] Unknown policy "${expose}". Define it in init()({ policies }).`);
      }
      return Object.freeze({ [BRAND]: kind, kind, outputSchema: undefined, ...def, check });
    };

  return {
    /** Create the registry once at startup: `createRegistry({ modules, database, services })`. */
    createRegistry: <const Mods extends Record<string, object>>(options: TypedOptions<C, Mods>) =>
      build<ScopeOf<C>, Mods>(options as RegistryOptions<Mods>, {}), // meta in wrap is typed by MetaOf<C>; the values come from typed defs
    /** Reads data. Can run other queries. No writes, no events, no services. */
    query: make("query") as Constructor<C, "query", P>,
    /** Changes data inside one transaction. Can run queries and mutations (same transaction) and emit events. */
    mutation: make("mutation") as Constructor<C, "mutation", P>,
    /** Talks to the outside world (payments, email, AI). No transaction; each mutation it runs commits on its own. */
    action: make("action") as Constructor<C, "action", P>,
    /** Something that happened. Emitted by mutations, delivered after commit. */
    event: <S extends Schema>(def: { schema: S; description?: string }): EventDef<In<S>, Out<S>> =>
      Object.freeze({ [BRAND]: "event" as const, kind: "event" as const, ...def }),
    /** React to an event after commit, like an action. Must be idempotent. `on(() => bookings.confirmed, ...)` */
    on: <O>(
      event: () => EventDef<any, O>,
      execute: (payload: O, ctx: ListenerCtx<C, O>) => Promise<unknown>,
      opts: { description?: string } = {},
    ): Listener<O> =>
      Object.freeze({
        [BRAND]: "listener" as const,
        kind: "listener" as const,
        event,
        description: opts.description,
        execute: execute as Listener<O>["execute"],
      }),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * createRegistry
 * ──────────────────────────────────────────────────────────────────────────── */

const INTERNAL: unique symbol = Symbol.for("logic-sdk.internal") as any;

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
  opts: CallerOptions & { eventDepth?: number };
  tx?: TxState;
}

export interface Overrides {
  database?: DatabaseAdapter<any, any>;
  services?: object;
  events?: Dispatcher;
  now?: () => Date;
  stubs?: Map<Fn, (input: any, ctx: any) => Promise<any>>;
  record?: (envelope: Envelope) => void;
}

export type Registry<S extends object = object, Mods extends Record<string, object> = Record<string, object>> = ReturnType<
  typeof build<S, Mods>
>;

/** Create the registry once at startup. Prefer the `createRegistry` returned by `init()`: it's typed with your config. */
export function createRegistry<S extends object = object, const Mods extends Record<string, object> = Record<string, object>>(
  options: RegistryOptions<Mods>,
) {
  return build<S, Mods>(options, {});
}

const describeIssues = (issues: readonly StandardSchemaV1.Issue[]) =>
  issues.map((i) => ({ message: i.message, path: i.path?.map((p) => (typeof p === "object" ? p.key : p)) }));

/**
 * What `createRegistry` finds in your modules, without a database or services: every function, event and
 * listener with its id. For tools (the CLI, docs generators) that inspect an app without running it.
 */
export function describeModules(modules: Record<string, object>) {
  const ids = new Map<object, string>();
  const functions: RegisteredFn[] = [];
  const events: (Registered & { event: EventDef })[] = [];
  const listeners: (Registered & { listener: Listener; event: EventDef })[] = [];

  for (const [module, ns] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(ns)) {
      if (!value || typeof value !== "object" || !(BRAND in value) || ids.has(value)) continue;
      const id = `${module}.${name}`;
      ids.set(value, id);
      const kind = (value as any)[BRAND];
      if (kind === "event") events.push({ id, module, name, event: value as EventDef });
      else if (kind === "listener") {
        const listener = value as Listener;
        listeners.push({ id, module, name, listener, event: listener.event() });
      } else functions.push({ id, module, name, kind, fn: value as Fn, exposed: typeof (value as Fn).check === "function" });
    }
  }
  return { ids, functions, events, listeners };
}

function build<S extends object, Mods extends Record<string, object>>(options: RegistryOptions<Mods>, o: Overrides) {
  const { ids, functions, events, listeners } = describeModules(options.modules);

  const database = o.database ?? options.database;
  const services = o.services ?? options.services ?? {};
  const dispatcher = o.events ?? options.events ?? inProcess();
  const now = o.now ?? options.now ?? (() => new Date());
  const wrap = options.wrap ?? ((_c, next) => next());
  const maxEventDepth = options.maxEventDepth ?? 8;
  const attempts = Math.max(1, options.retry?.attempts ?? 3);
  const reportRaw =
    options.onError ?? ((e, info) => console.error(`[logic-sdk] ${info.listener} failed`, e));
  const report = (e: unknown, info: { listener: string; envelope: Envelope | undefined }) => {
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

  const idOf = (x: object) => {
    const id = ids.get(x);
    if (!id) throw new Error("[logic-sdk] This function or event isn't registered. Add its module to createRegistry({ modules }).");
    return id;
  };

  async function parseInput(schema: Schema, value: unknown, code: string) {
    const r = await schema["~standard"].validate(value);
    if (r.issues) throw new DomainError("invalid", code, { issues: describeIssues(r.issues) });
    return r.value;
  }
  /** Output and event payloads are produced by our own code: invalid means a bug, not a bad request. */
  async function parseOwn(schema: Schema, value: unknown, what: string) {
    const r = await schema["~standard"].validate(value);
    if (r.issues) throw new Error(`[logic-sdk] ${what} is invalid: ${JSON.stringify(describeIssues(r.issues))}`);
    return r.value;
  }

  // ── listeners ────────────────────────────────────────────────────────────
  const byEvent = new Map<string, (Registered & { listener: Listener })[]>();
  for (const l of listeners) {
    const name = idOf(l.event);
    byEvent.set(name, [...(byEvent.get(name) ?? []), l]);
  }
  const eventByName = new Map(events.map((e) => [e.id, e.event]));

  /** Run every listener for one envelope. Returns the failures instead of throwing. */
  async function runListeners(envelope: Envelope, eventDepth: number) {
    const failures: { listener: string; error: unknown }[] = [];
    const event = eventByName.get(envelope.name);
    for (const l of byEvent.get(envelope.name) ?? []) {
      const frame: Frame = { scope: envelope.scope, depth: 0, opts: { eventDepth } };
      try {
        await wrap({ id: l.id, kind: "listener", meta: undefined, input: envelope.payload, scope: envelope.scope, depth: 0 }, async () => {
          const payload = event ? await parseOwn(event.schema, envelope.payload, `${envelope.name} payload`) : envelope.payload;
          return l.listener.execute(payload, { ...actionCtx(frame, l.id), event: { ...envelope, payload } });
        });
      } catch (error) {
        failures.push({ listener: l.id, error });
      }
    }
    return failures;
  }

  /** In-process delivery: failures go to onError. */
  const deliverOne = (eventDepth: number) => async (envelope: Envelope) => {
    for (const f of await runListeners(envelope, eventDepth)) report(f.error, { listener: f.listener, envelope });
  };

  /** Public: for durable dispatchers. Throws an AggregateError if any listener failed, so the consumer can retry. */
  async function dispatch(envelope: Envelope) {
    const failures = await runListeners(envelope, 1);
    if (failures.length)
      throw new AggregateError(
        failures.map((f) => f.error),
        `[logic-sdk] ${failures.length} listener(s) failed for ${envelope.name}: ${failures.map((f) => f.listener).join(", ")}`,
      );
  }

  // ── ctx ──────────────────────────────────────────────────────────────────
  const child = (frame: Frame): Frame => ({ ...frame, depth: frame.depth + 1 });
  const rescope = (frame: Frame, patch: object): Frame => ({ ...frame, scope: { ...frame.scope, ...patch } });

  function queryCtx(frame: Frame, id: string): QueryCtx<any> {
    return {
      ...failFor(id),
      scope: frame.scope,
      now,
      signal: frame.opts.signal,
      db: frame.tx ? frame.tx.db : database?.db,
      run: (fn, input) => invoke(fn, input, child(frame), ["query"]),
      with: (patch) => queryCtx(rescope(frame, patch), id),
    };
  }
  function mutationCtx(frame: Frame, id: string): MutationCtx<any> {
    const tx = frame.tx!;
    return {
      ...failFor(id),
      scope: frame.scope,
      now,
      signal: frame.opts.signal,
      db: tx.db,
      run: (fn, input) => invoke(fn, input, child(frame), ["query", "mutation"]),
      emit: (event, payload) => {
        const name = idOf(event);
        payload = structuredClone(payload); // what was emitted is what gets delivered, even if the caller mutates it after
        // reserve the slot now so events keep emit order, even with async schemas
        const envelope: Envelope = {
          id: crypto.randomUUID(),
          name,
          payload,
          scope: structuredClone(frame.scope),
          occurredAt: now().toISOString(),
        };
        tx.outbox.push(envelope);
        const check = parseOwn(event.schema, payload, `${name} payload`).then(() => {});
        check.catch(() => {}); // surfaced at commit; never an unhandled rejection
        tx.pending.push(check);
      },
      with: (patch) => mutationCtx(rescope(frame, patch), id),
    };
  }
  function actionCtx(frame: Frame, id: string): ActionCtx<any> {
    return {
      ...failFor(id),
      scope: frame.scope,
      now,
      signal: frame.opts.signal,
      services,
      run: (fn, input) => invoke(fn, input, child({ ...frame, tx: undefined }), ["query", "mutation", "action"]),
      with: (patch) => actionCtx(rescope(frame, patch), id),
    };
  }

  // ── invoke ───────────────────────────────────────────────────────────────
  async function invoke(fn: Fn, rawInput: unknown, frame: Frame, allowed: Kind[]): Promise<any> {
    const id = idOf(fn);
    if (!allowed.includes(fn.kind))
      throw new Error(`[logic-sdk] ${id} is a ${fn.kind}; it can't be run from here (allowed: ${allowed.join(", ")}).`);

    const call: Call = { id, kind: fn.kind, meta: fn.meta, input: rawInput, scope: frame.scope, depth: frame.depth };

    /** Validate and check before any transaction opens: bad or denied calls never touch the database. */
    const prepare = async () => {
      frame.opts.signal?.throwIfAborted();
      const input = await parseInput(fn.inputSchema, rawInput, `${id}.invalid_input`);
      if (fn.check && !(await fn.check(frame.scope, input))) throw new DomainError("forbidden", `${id}.forbidden`);
      return input;
    };
    const execute = async (input: unknown, ctx: unknown) => {
      const stub = o.stubs?.get(fn);
      const out = await (stub ? stub(input, ctx) : fn.execute(input, ctx));
      return fn.outputSchema ? parseOwn(fn.outputSchema, out, `${id} output`) : out;
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
      let committed: { out: unknown; outbox: Envelope[] };
      for (let attempt = 1; ; attempt++) {
        let state: TxState | undefined;
        try {
          committed = await database!.transaction(async (txDb) => {
            // fresh per attempt, so a retry never reuses events from a failed attempt
            const tx: TxState = (state = { db: txDb, doomed: false, reason: undefined, outbox: [], pending: [] });
            const out = await execute(input, mutationCtx({ ...frame, tx }, id));
            await Promise.all(tx.pending);
            if (tx.doomed) throw tx.reason;
            await dispatcher.enqueue?.(txDb, tx.outbox);
            return { out, outbox: tx.outbox };
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
      if (committed.outbox.length) await afterCommit(committed.outbox, frame);
      return committed.out;
    });
  }

  async function afterCommit(outbox: Envelope[], frame: Frame) {
    try {
      for (const e of outbox) o.record?.(e);
      const eventDepth = (frame.opts.eventDepth ?? 0) + 1;
      if (eventDepth > maxEventDepth) {
        report(new Error(`[logic-sdk] event chain deeper than ${maxEventDepth}: stopped delivering (listener loop?)`), {
          listener: "(dispatcher)",
          envelope: outbox[0],
        });
        return;
      }
      const delivery = (async () => dispatcher.deliver(outbox, deliverOne(eventDepth)))().catch((e) =>
        report(e, { listener: "(dispatcher)", envelope: outbox[0] }),
      );
      if (options.waitUntil) {
        try {
          options.waitUntil(delivery);
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

  function makeCaller(scope: S, opts: CallerOptions): Caller<S> {
    return {
      scope,
      run: (fn, input) => invoke(fn, input, { scope, depth: 0, opts }, ["query", "mutation", "action"]),
      with: (patch) => makeCaller({ ...scope, ...patch }, opts),
    };
  }

  return {
    /** The modules you registered (typed), for adapters that build typed routers. */
    modules: options.modules,
    /** Bind who is calling, once per request, job or test: `const caller = registry.as(scope)`. */
    as: (scope: S, opts: CallerOptions = {}): Caller<S> => makeCaller(scope, opts),
    /** Everything the registry can do. Adapters read this. */
    functions: functions as readonly RegisteredFn[],
    events: events as readonly (Registered & { event: EventDef })[],
    listeners: listeners as readonly (Registered & { listener: Listener; event: EventDef })[],
    idOf,
    /** Deliver one stored envelope to its listeners (durable dispatchers). Throws if any listener failed, so you can retry. */
    dispatch,
    /** @internal used by `logic-sdk/testing` */
    [INTERNAL]: { options, overrides: o, derive: (more: Overrides) => build<S, Mods>(options, { ...o, ...more }) },
  };
}

/** @internal */
export const internal = (registry: Registry<any, any>) => registry[INTERNAL];
