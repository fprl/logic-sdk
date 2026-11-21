import type { StandardSchemaV1 } from "@standard-schema/spec";

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

type Schema<I = any, O = any> = StandardSchemaV1<I, O>;
type In<S> = S extends StandardSchemaV1<infer I, unknown> ? I : never;
type Out<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

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
  /**
   * Your app's settings, read as `ctx.config` in every function: base URL, limits, switches. Plain data, read-only.
   * Build it once from your env at the entry; clients built from secrets go in `services` instead.
   */
  config?: object;
  /** The shape of `meta` on your functions (tags, rate limits, "agent may call"...). Read by `wrap` and adapters. */
  meta?: object;
}
type ScopeOf<C extends Config> = C["scope"];
type DbOf<C extends Config> = C extends { db: infer D } ? D : never;
type ReaderOf<C extends Config> = C extends { reader: infer R } ? R : DbOf<C>;
type ServicesOf<C extends Config> = C extends { services: infer S } ? S : {};
type MetaOf<C extends Config> = C extends { meta: infer M } ? M : never;
/** Without a declared `config`, nothing may be passed or read: no silently ignored settings. */
type ConfigOf<C extends Config> = C extends { config: infer F } ? F : Record<string, never>;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
/** Read-only all the way down: what `ctx.config` gives you. Primitives (branded ones too) stay as they are. */
export type Frozen<T> = T extends Primitive
  ? T
  : T extends readonly (infer U)[]
    ? readonly Frozen<U>[]
    : { readonly [K in keyof T]: Frozen<T[K]> };
/** Any part of `T`, at any depth: what a test may override in `config`. Arrays are replaced whole, like at runtime. */
export type DeepPartial<T> = T extends Primitive | readonly unknown[] ? T : { [K in keyof T]?: DeepPartial<T[K]> };

export type Kind = "query" | "mutation" | "action";

declare const types: unique symbol;
const BRAND: unique symbol = Symbol.for("logic-sdk.brand");

/** A query, mutation or action. Call it with `caller.run(fn, input)` or `ctx.run(fn, input)`. */
export interface Fn<K extends Kind = Kind, I = unknown, O = unknown, E extends boolean = boolean> {
  readonly [BRAND]: K;
  readonly kind: K;
  /** Stable id, local to the module: `id: "send"` in `notifications` is `notifications.send`. Defaults to the export name. */
  readonly id?: string;
  /** What callers pass, validated on every call. Left out: the function takes nothing (`run(fn)`). */
  readonly input?: Schema;
  /** What callers get back, checked before it leaves. */
  readonly output?: Schema;
  /** Your own data about the function. Checked against `meta` in `init` where you set it, typed in `wrap`; loose here, for adapters. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Who may call it (from `authorize`). Runs on every call, before validation. */
  readonly authorize?: Policy<never>;
  /** `true`: adapters may publish it (HTTP, oRPC, AI tools). Requires `authorize` and `output`. */
  readonly expose?: true;
  readonly handler: (ctx: never, input: never) => Promise<unknown>;
  /** Phantom types, never set at runtime. */
  readonly [types]?: { input: I; output: O; exposed: E };
}
/** The exposed functions of one module: what adapters publish. */
export type ExposedOf<T> = { [N in keyof T as T[N] extends Fn<Kind, unknown, unknown, true> ? N : never]: T[N] };
/** A function with `expose: true`: adapters may publish it. */
export type ExposedFn<K extends Kind = Kind, I = unknown, O = unknown> = Fn<K, I, O, true>;
/** What callers pass to a function. */
export type FnIn<F> = F extends Fn<Kind, infer I, unknown> ? I : never;
/** What a function returns. */
export type FnOut<F> = F extends Fn<Kind, unknown, infer O> ? O : never;

/** `I`: what `emit` takes. `O`: what listeners receive (after the payload schema's transforms and defaults). */
export interface EventDef<I = unknown, O = I> {
  readonly [BRAND]: "event";
  readonly kind: "event";
  /** Stable id, local to the module: `id: "send"` in `notifications` is `notifications.send`. Defaults to the export name. */
  readonly id?: string;
  /** The payload's schema, checked when emitted and again at delivery. */
  readonly payload: Schema;
  readonly [types]?: { input: I; payload: O };
}

/**
 * What a dispatcher stores and delivers. Fully JSON: `payload` is what was emitted (validated),
 * and listeners get it parsed again by the event's payload schema at delivery.
 */
export interface Envelope<P = unknown, S = object> {
  id: string;
  name: string;
  payload: P;
  scope: S;
  occurredAt: string;
  /** Hops in the chain: 1 for an event a caller's mutation emitted, +1 each time a listener's mutation emits. */
  depth: number;
}

/**
 * One listener's share of one event: what a queue carries, one message each, so a failing listener retries alone.
 * `id` (`<listener id>@<event id>`) is the key to dedupe on.
 */
export interface Delivery<P = unknown, S = object> {
  /** What kind of job this is. Stored with it, so jobs queued today still run when other kinds exist. */
  kind: "delivery";
  id: string;
  /** The listener's id, `"<module>.<id or export>"`. */
  listener: string;
  envelope: Envelope<P, S>;
  /** When it may run (ISO), for a listener with a `delay`. Absent: right away. */
  runAt?: string;
}

/** One unit of background work, what `registry.jobs` runs, sweeps and retries. Today every job is a delivery. */
export type Job = Delivery;

/**
 * What delivering one resolved to. `failed`: a rule said no (`invalid`, `unauthenticated`, `forbidden`, `not_found`,
 * `rejected`) or the payload no longer matches its schema. Retrying can't help, so acknowledge it; it's been reported.
 * `discarded`: `jobs.scope.load` returned null (who it ran as is gone). Acknowledge it too; it's been reported.
 */
export type DeliveryOutcome = "done" | "failed" | "discarded";

/** The event a listener is handling. No scope here: `ctx.scope` is the one it runs as. */
export interface ListenerEvent<O = unknown> {
  id: string;
  name: string;
  payload: O;
  occurredAt: string;
  /** 1 on the first try. Queues count their redeliveries. */
  attempt: number;
}

export interface Listener<O = unknown> {
  readonly [BRAND]: "listener";
  readonly kind: "listener";
  /** Stable id, local to the module: `id: "send"` in `notifications` is `notifications.send`. Defaults to the export name. */
  readonly id?: string;
  /** Lazy, so listeners can import other modules' barrels without import cycles. */
  readonly event: () => EventDef<unknown, O>;
  /** Tries in total, the first included. Default 1. */
  readonly attempts?: number;
  /** Seconds after the event before the first try. Default 0. */
  readonly delay?: number;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly handler: (ctx: never, payload: O) => Promise<unknown>;
}

/** What a single call may change: who it runs as (part of the scope) and when to give up. Nothing else. */
export interface RunOptions<S = object> {
  /**
   * Merged over the current scope for this call and everything it runs: `{ scope: { actor: system } }` to act as
   * someone else on purpose, `{ scope: { locale: "es" } }` to render in another language. The callee's policy sees it.
   */
  scope?: Partial<S>;
  /**
   * Checked before this call starts. Inside, actions get it as `ctx.signal` to pass on (`fetch(url, { signal })`).
   * Never checked between your steps, so a caller who gives up can't leave a workflow half done.
   */
  signal?: AbortSignal;
}
/** `run(fn, input, options?)`, or `run(fn)` for a function that takes no input. */
export type RunArgs<F, S> = undefined extends FnIn<F>
  ? [input?: FnIn<F>, options?: RunOptions<S>]
  : [input: FnIn<F>, options?: RunOptions<S>];
type Run<Allowed extends Kind, S> = <F extends Fn<Allowed>>(fn: F, ...args: RunArgs<F, S>) => Promise<FnOut<F>>;

/**
 * Expected failures, namespaced to the module you're in: inside `bookings`, `ctx.errors.reject("not_pending")` has
 * code `"bookings.not_pending"`. Throw what they return. Codes are plain strings on purpose (see the errors docs).
 */
export interface Errors {
  /** A business rule said no, and trying again won't help. `throw ctx.errors.reject("not_pending", { status })` */
  reject(code: string, details?: unknown): DomainError;
  /** Someone else got there first, or it already exists. Refreshing and retrying may work. */
  conflict(code: string, details?: unknown): DomainError;
  /** It doesn't exist, or isn't visible in this scope. Code defaults to `"<module>.not_found"`. */
  notFound(code?: string, details?: unknown): DomainError;
  /** The caller is known but may not do this. Code defaults to `"<module>.<function>.forbidden"`. */
  deny(code?: string, details?: unknown): DomainError;
}
interface BaseCtx<C extends Config, S> {
  scope: S;
  /** Your settings from `createRegistry({ config })`. Read-only; tests override parts of it. */
  config: Frozen<ConfigOf<C>>;
  /** Expected failures: `throw ctx.errors.reject("not_pending")`. */
  errors: Errors;
  /** Current time. Fixed in tests. */
  now: () => Date;
}
/** `S` is the scope, narrowed by the function's policy. Alias it next to `init`: `type QueryCtx = QueryCtx<Config>`. */
export interface QueryCtx<C extends Config, S = ScopeOf<C>> extends BaseCtx<C, S> {
  db: ReaderOf<C>;
  /** Call another query, with its policy, validation and output check: `await ctx.run(pricing.quote, { nights })`. */
  run: Run<"query", ScopeOf<C>>;
}
export interface MutationCtx<C extends Config, S = ScopeOf<C>> extends BaseCtx<C, S> {
  db: DbOf<C>;
  /**
   * Call a query or mutation inside this same transaction, with its policy and validation:
   * `await ctx.run(availability.hold, { propertyId })`. If it fails, the whole transaction rolls back.
   */
  run: Run<"query" | "mutation", ScopeOf<C>>;
  /** Queue an event. Delivered to listeners only after the transaction commits. */
  emit<I>(event: EventDef<I, unknown>, payload: I): void;
}
export interface ActionCtx<C extends Config, S = ScopeOf<C>> extends BaseCtx<C, S> {
  services: ServicesOf<C>;
  /** Call any function: `await ctx.run(bookings.confirmPaid, { bookingId })`. Each mutation you run commits on its own. */
  run: Run<Kind, ScopeOf<C>>;
  /** The caller's abort signal: pass it on, `fetch(url, { signal: ctx.signal })`. Always undefined in listeners (they outlive the request). */
  signal: AbortSignal | undefined;
}
export interface ListenerCtx<C extends Config, O = unknown> extends ActionCtx<C> {
  event: ListenerEvent<O>;
}

/**
 * Who may call a function at all: signed in, admin, staff. Sync, reads only the scope, returns exactly `true` to allow.
 * Write it as a type guard (`(s): s is Admin => ...`) to narrow `ctx.scope` in `handler`.
 * Rules about one record ("only the owner may cancel") go in `handler`, after loading it.
 */
export type Policy<S> = (scope: S) => boolean;
type Guarded<F, S> = F extends (scope: any) => scope is infer G ? G : S;
type CtxOf<C extends Config, K extends Kind, S> = K extends "query"
  ? QueryCtx<C, S>
  : K extends "mutation"
    ? MutationCtx<C, S>
    : ActionCtx<C, S>;

/** What a function without `input` gets: nothing. */
type NoInput = StandardSchemaV1<undefined, undefined>;
type Def<C extends Config, K extends Kind, IS, OS, R, P> = {
  /**
   * Stable id, local to its module: in a `notifications` module, `id: "send"` is `notifications.send`. Jobs store it,
   * so set it before you rename the export and queued jobs keep finding this code. Defaults to the export name.
   */
  id?: string;
  /** What callers pass, validated on every call. Leave it out when the function takes nothing. */
  input?: IS;
  /** Who may call it, on every call. A type guard narrows `ctx.scope` in `handler`. Required with `expose`. */
  authorize?: P;
  meta?: MetaOf<C>;
  handler: (ctx: CtxOf<C, K, Guarded<P, ScopeOf<C>>>, input: Out<IS>) => Promise<[OS] extends [Schema] ? In<OS> : R>;
};
/**
 * `expose: true` makes `authorize` and `output` required: you can't publish something without saying who may call it,
 * and what leaves your process is a contract. `expose` itself is then required too, so a maybe-undefined flag is an
 * error and the types agree with what adapters publish. Internal functions may skip both; `authorize` still runs if set.
 */
type Exposure<C extends Config, OS, X> = [X] extends [true]
  ? {
      /** `true`: adapters may publish it (HTTP, oRPC, AI tools). */
      expose: true;
      authorize: Policy<ScopeOf<C>>;
      /** What callers get back, checked before it leaves. */
      output: OS;
    }
  : {
      /** `true`: adapters may publish it (HTTP, oRPC, AI tools). Leave it out for internal functions. */
      expose?: X;
      /** What callers get back, checked before it leaves. */
      output?: OS;
    };

/**
 * One signature, not overloads, so a mistake gets one error naming the missing field ("Property 'output' is missing")
 * instead of "No overload matches this call". Keep `output: OS` plain: `OS & Schema` makes TypeScript compare the whole
 * schema type structurally on every definition (about 10x slower to check).
 */
type Constructor<C extends Config, K extends Kind> = <
  IS extends Schema = NoInput,
  OS extends Schema | undefined = undefined,
  R = unknown,
  P extends Policy<ScopeOf<C>> = Policy<ScopeOf<C>>,
  X extends true | undefined = undefined,
>(
  def: Def<C, K, IS, OS, R, P> & Exposure<C, OS, X>,
) => Fn<K, In<IS>, [OS] extends [Schema] ? Out<OS> : R, [X] extends [true] ? true : false>;

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
/** `isDomainError(e)`, or with a code: `isDomainError(e, "availability.dates_unavailable")`. */
export const isDomainError = (e: unknown, code?: string): e is DomainError =>
  e instanceof DomainError && (code === undefined || e.code === code);

/** `ctx.errors` for one function or listener (`id` like "bookings.confirm"). */
const errorsFor = (id: string): Errors => {
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

/** Delivers one: resolves when the listener is done or failed for good (acknowledge it), throws when a retry might help. */
export type RunDelivery = (delivery: Delivery, options?: { attempt?: number }) => Promise<DeliveryOutcome>;

/** What a sweep did: delivered, failed for good, or put back with a backoff. */
export interface SweepResult {
  done: number;
  failed: number;
  discarded: number;
  retrying: number;
}

/** What the registry hands an adapter: run a job here, or report a failure of the adapter's own (a send that failed). */
export interface Runner {
  /** Every failure it meets is already reported to `onError`; a throw means "retry it". */
  run: RunDelivery;
  report(error: unknown, job: Job, attempt?: number): void;
}

export interface Dispatcher {
  /** At `createRegistry`: refuse a setup this adapter can't honour (a delay longer than the queue allows). */
  check?(setup: { listeners: readonly RegisteredListener[]; database: DatabaseAdapter<unknown, unknown> | undefined }): void;
  /** Inside the transaction, before commit. In-process: nothing. Outbox: insert one row per delivery with `tx`. */
  enqueue?(tx: unknown, deliveries: Delivery[]): Promise<void>;
  /** After commit: run them, or hand them to a queue. A throw is reported to `onError`. */
  deliver(deliveries: Delivery[], runner: Runner): Promise<void>;
  /** Run what's due (retries, deliveries whose runner crashed). Only dispatchers that store deliveries have it. */
  sweep?(runner: Runner, options?: { limit?: number }): Promise<SweepResult>;
  /** Put a failed job back in line. `false` when there's no failed job with that id. Only dispatchers that store them. */
  retry?(id: string): Promise<boolean>;
  /**
   * Keep a job that failed for good after it left the adapter: `registry.jobs.run` calls it from a queue consumer, so
   * the outbox stores the failure Cloudflare would otherwise drop. Not called for jobs the adapter ran itself.
   */
  fail?(job: Job, error: unknown): Promise<void>;
}

/** What `onError` gets with a failure after commit. `delivery`, `attempt` and `outcome` are set when a listener's job failed. */
export interface FailureInfo {
  listener: string;
  envelope: Envelope | undefined;
  delivery?: string;
  attempt?: number;
  /** `retry`: tries are left and the adapter may run it again. `failed` and `discarded`: it's over. */
  outcome?: "retry" | "failed" | "discarded";
}

/**
 * Default dispatcher: delivers right after commit, in this process, once, ignoring `attempts` and `delay` (like Laravel's
 * sync queue). Lost on crash: use an outbox when that matters.
 */
export const inProcess = (): Dispatcher => ({
  async deliver(deliveries, { run }) {
    for (const d of deliveries) await run(d).catch(() => {}); // already reported; nothing retries in-process
  },
});

/**
 * Who a job runs as, at rest. `store` picks what's saved with the job (ids, not whole objects); `load` rebuilds the
 * scope when it runs, so policies see today's roles. `load` returning null discards the job (reported to `onError`),
 * a throw retries it. By default the scope is stored as it was at emit. `store` needs `load`: listeners run as a scope,
 * not as what was saved.
 */
export interface JobScope<S = object, T = any> {
  store?: (scope: S) => T;
  /** What `store` saved. Write `store` first so TypeScript infers it (or annotate this parameter). */
  load?: (stored: T) => S | null | Promise<S | null>;
}

/** `createRegistry({ jobs })`: where background work goes, and what every adapter applies. */
export interface JobsOptions<S = object, T = any> {
  /** `inProcess()` (default), or a durable one like `outbox(db)`. Its own options go in its factory. */
  adapter?: Dispatcher;
  /** Applied by the registry in every adapter, `inProcess()` and tests included. */
  scope?: JobScope<S, T>;
}

export interface Call<M = unknown> {
  id: string;
  kind: Kind | "listener";
  /** The function's or listener's `meta` (undefined when it has none). */
  meta: M | undefined;
  /** Raw input as received (before validation). */
  input: unknown;
  scope: object;
  depth: number;
}

export interface RegistryOptions<Mods extends Record<string, object>> {
  /** One entry per module: `{ bookings, availability }` with `import * as bookings from "./bookings"`. */
  modules: Mods;
  database?: DatabaseAdapter<unknown, unknown>;
  services?: object;
  /** Settings every function reads as `ctx.config`. Plain data: it's copied and frozen. */
  config?: object;
  /** Background work: `jobs: { adapter: outbox(db), scope: { store, load } }`. Default: in-process, scope as-is. */
  jobs?: JobsOptions;
  /** Wraps every call, including ones that fail validation or authorization: logging, tracing, audit. */
  wrap?: (call: Call, next: () => Promise<unknown>) => Promise<unknown>;
  /**
   * Serverless: let listeners finish after the response. Pass the platform's global:
   * `import { waitUntil } from "cloudflare:workers"` or `import { waitUntil } from "@vercel/functions"`.
   * Without it, `run` waits for listeners, which is what tests and long-lived servers want.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Failures after commit land here (listeners, dispatcher). They never fail the caller. */
  onError?: (error: unknown, info: FailureInfo) => void;
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

/** A registry bound to who is calling: `const caller = registry.as(scope)`. */
export interface Caller<S extends object = object> {
  readonly scope: S;
  /** Run any function as this caller: `await caller.run(bookings.cancel, input, { signal: request.signal })`. */
  run<F extends Fn>(fn: F, ...args: RunArgs<F, S>): Promise<FnOut<F>>;
}

export interface Registered {
  id: string;
  module: string;
  name: string;
}
export interface RegisteredFn extends Registered {
  fn: Fn;
  kind: Kind;
  /** Has `expose: true`: adapters may publish it. */
  exposed: boolean;
}

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
      if (attempts !== undefined && !(Number.isInteger(attempts) && attempts >= 1))
        throw new Error(`[logic-sdk] listener attempts must be a whole number of tries, 1 or more (got ${attempts}).`);
      if (delay !== undefined && !(Number.isFinite(delay) && delay >= 0))
        throw new Error(`[logic-sdk] listener delay must be seconds, 0 or more (got ${delay}).`);
      // meta is checked against your MetaOf<C> above and stored loose, like Fn.meta, for wrap and adapters
      return Object.freeze({ [BRAND]: "listener" as const, kind: "listener" as const, id, event, attempts, delay, meta: meta as Listener["meta"], handler });
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * createRegistry
 * ──────────────────────────────────────────────────────────────────────────── */

const INTERNAL: unique symbol = Symbol.for("logic-sdk.internal");

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

export interface Overrides {
  database?: DatabaseAdapter<unknown, unknown>;
  services?: object;
  /** Merged over the registry's config, section by section. */
  config?: object;
  adapter?: Dispatcher;
  now?: () => Date;
  stubs?: Map<Fn, (ctx: never, input: never) => Promise<unknown>>;
  record?: (envelope: Envelope) => void;
  onError?: (error: unknown, info: FailureInfo) => void;
  /** Present and undefined turns the registry's off. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface RegisteredEvent extends Registered {
  event: EventDef;
}
export interface RegisteredListener extends Registered {
  listener: Listener;
  event: EventDef;
}

/** `registry.jobs`: what you call from a queue consumer, a cron, or a script. */
export interface Jobs {
  /**
   * Run one stored job (queue consumers): `await registry.jobs.run(message.body, { attempt: message.attempts })`.
   * Resolves `"done"`, `"failed"` or `"discarded"` (acknowledge all three); throws when a retry might help and the
   * listener has tries left. A `failed` job goes to your adapter's `fail` (the outbox keeps it).
   */
  run(job: Job, options?: { attempt?: number }): Promise<DeliveryOutcome>;
  /**
   * Run what your transport has due, from a cron or an interval: `await registry.jobs.sweep()`. With `outbox(db)`, that's
   * retries whose backoff is over and jobs whose runner crashed. Transports that store nothing resolve zeros.
   */
  sweep(options?: { limit?: number }): Promise<SweepResult>;
  /**
   * Put a failed job back in line with a fresh set of attempts. `false` when no failed job has that id (it's pending,
   * running, done, or never existed). Throws when your transport stores no jobs, like `inProcess()`.
   */
  retry(id: string): Promise<boolean>;
}

/** What `createRegistry` returns. `Cf` is your config's type, so tests can override parts of it. */
export interface Registry<S extends object = object, Mods extends Record<string, object> = Record<string, object>, Cf = unknown> {
  /** The modules you registered (typed), for adapters that build typed routers. */
  readonly modules: Mods;
  /** Bind who is calling, once per request, job or test: `const caller = registry.as(scope)`. */
  as(scope: S): Caller<S>;
  /** Everything you registered, with ids. Adapters and plugins read this. */
  readonly definitions: {
    readonly functions: readonly RegisteredFn[];
    readonly events: readonly RegisteredEvent[];
    readonly listeners: readonly RegisteredListener[];
  };
  /** `"bookings.confirm"` for a registered function or event. Throws for anything unregistered. */
  idOf(fnOrEvent: object): string;
  /** The background work your `jobs` transport holds. */
  readonly jobs: Jobs;
  /** @internal used by `logic-sdk/testing` */
  readonly [INTERNAL]: {
    options: RegistryOptions<Mods>;
    config: Frozen<Cf>;
    derive(more: Overrides): Registry<S, Mods, Cf>;
  };
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

const describeIssues = (issues: readonly StandardSchemaV1.Issue[]) =>
  issues.map((i) => ({ message: i.message, path: i.path?.map((p) => (typeof p === "object" ? p.key : p)) }));

/** A payload that stopped matching its event's schema (a deploy changed it while it waited): delivering again won't help. */
class StalePayload extends Error {}

/** A job this code can't run: an unknown kind, or a listener that was renamed or removed. A retry after a deploy might help. */
export class UnknownJob extends Error {}

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

const isBranded = (v: unknown): v is Fn | EventDef | Listener => !!v && typeof v === "object" && BRAND in v;

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
      else {
        checkExposure(id, value);
        functions.push({ id, module, name, kind: value.kind, fn: value, exposed: value.expose === true });
      }
    }
  }
  return { ids, functions, events, listeners };
}

function build<S extends object, Mods extends Record<string, object>, Cf = unknown>(
  options: RegistryOptions<Mods>,
  o: Overrides,
): Registry<S, Mods, Cf> {
  const { ids, functions, events, listeners } = describeModules(options.modules);

  const database = o.database ?? options.database;
  const services = o.services ?? options.services ?? {};
  const config = freezeConfig(mergeConfig(options.config ?? {}, o.config)) as Frozen<Cf>;
  const dispatcher = o.adapter ?? options.jobs?.adapter ?? inProcess();
  const keepFailed = dispatcher.fail?.bind(dispatcher);
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

  // ── listeners ────────────────────────────────────────────────────────────
  const byEvent = new Map<string, RegisteredListener[]>();
  for (const l of listeners) {
    const name = idOf(l.event);
    byEvent.set(name, [...(byEvent.get(name) ?? []), l]);
  }
  const eventByName = new Map(events.map((e) => [e.id, e.event]));

  const listenerById = new Map(listeners.map((l) => [l.id, l]));

  /** One delivery per listener of each event, unless the chain is too deep (a listener loop). */
  function toDeliveries(envelopes: Envelope[]): Delivery[] {
    const tooDeep = envelopes.find((e) => e.depth > maxEventDepth);
    if (tooDeep) {
      report(new Error(`[logic-sdk] event chain deeper than ${maxEventDepth}: stopped delivering (listener loop?)`), { listener: "(dispatcher)", envelope: tooDeep });
      return [];
    }
    return envelopes.flatMap((e) =>
      (byEvent.get(e.name) ?? []).map((l): Delivery => {
        const job: Delivery = { kind: "delivery", id: `${l.id}@${e.id}`, listener: l.id, envelope: e };
        const delay = l.listener.delay;
        if (delay) job.runAt = new Date(Date.parse(e.occurredAt) + delay * 1000).toISOString();
        return job;
      }),
    );
  }

  /**
   * Run one listener for one event. Reports every failure; throws only when a retry might help and the listener has
   * tries left. `fail` keeps a job that failed for good, when it ran outside its adapter (a queue consumer).
   */
  async function deliver(delivery: Delivery, options: { attempt?: number } = {}, fail?: (error: unknown) => Promise<void>): Promise<DeliveryOutcome> {
    const { envelope } = delivery;
    const attempt = options.attempt ?? 1;
    const info: FailureInfo = { listener: delivery.listener, envelope, delivery: delivery.id, attempt };
    const failed = async (error: unknown) => {
      report(error, { ...info, outcome: "failed" });
      await fail?.(error);
      return "failed" as const;
    };
    if (delivery.kind !== "delivery") {
      const e = new UnknownJob(`[logic-sdk] job ${delivery.id} has kind ${JSON.stringify(delivery.kind)}, which this version can't run.`);
      report(e, { ...info, outcome: "retry" });
      throw e;
    }
    const l = listenerById.get(delivery.listener);
    if (!l) {
      const e = new UnknownJob(`[logic-sdk] ${delivery.listener} isn't a registered listener (renamed or removed?), so delivery ${delivery.id} can't run.`);
      report(e, { ...info, outcome: "retry" });
      throw e;
    }
    // read from the code, like Rails' retry_on: a deploy that changes it applies to jobs already queued
    const attempts = l.listener.attempts ?? 1;
    // its last try was claimed but never finished: a crash, or a listener slower than the lease (Laravel checks this too)
    if (attempt > attempts)
      return failed(new Error(`[logic-sdk] ${delivery.id} has used its ${attempts} attempt(s): the last one never finished (crashed or outlived the lease).`));
    const event = eventByName.get(envelope.name);
    try {
      let scope = envelope.scope;
      if (jobScope?.load) {
        const loaded = await jobScope.load(scope);
        if (loaded === undefined) throw new Error(`[logic-sdk] jobs.scope.load returned undefined for ${delivery.id}. Return the scope, or null to discard the job.`);
        if (loaded === null) {
          report(new Error(`[logic-sdk] jobs.scope.load returned null for ${delivery.id}, so it was discarded.`), { ...info, outcome: "discarded" });
          return "discarded";
        }
        scope = loaded;
      }
      const frame: Frame = { scope, depth: 0, eventDepth: envelope.depth };
      await wrap({ id: l.id, kind: "listener", meta: l.listener.meta, input: envelope.payload, scope, depth: 0 }, async () => {
        let payload = envelope.payload;
        if (event) {
          const r = await event.payload["~standard"].validate(payload);
          if (r.issues) throw new StalePayload(`[logic-sdk] ${envelope.name} payload no longer matches its schema: ${JSON.stringify(describeIssues(r.issues))}`);
          payload = r.value;
        }
        const ctxEvent: ListenerEvent = { id: envelope.id, name: envelope.name, payload, occurredAt: envelope.occurredAt, attempt };
        return l.listener.handler({ ...actionCtx(frame, l.id), event: ctxEvent } as never, payload); // SAFETY: as in invoke
      });
      return "done";
    } catch (error) {
      const retrying = attempt < attempts && !(error instanceof StalePayload) && !(isDomainError(error) && error.kind !== "conflict");
      if (!retrying) return failed(error);
      report(error, { ...info, outcome: "retry" });
      throw error;
    }
  }

  const runner: Runner = {
    run: deliver,
    report: (e, job, attempt) => report(e, { listener: job.listener, envelope: job.envelope, delivery: job.id, attempt }),
  };

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
        const name = idOf(event);
        // a queue carries JSON: a Date or a class instance would work in-process and break only in production
        assertPlain(payload, `${name} payload`, "Events travel through queues as JSON: send an ISO string and let the schema turn it into a Date");
        const stored = jobScope?.store ? jobScope.store(frame.scope) : frame.scope;
        assertPlain(stored, `the scope emitting ${name}`, "Events carry the scope through queues as JSON: keep it to ids (jobs.scope.store picks what's saved)");
        payload = structuredClone(payload); // what was emitted is what gets delivered, even if the caller mutates it after
        // reserve the slot now so events keep emit order, even with async schemas
        const envelope: Envelope = {
          id: crypto.randomUUID(),
          name,
          payload,
          scope: structuredClone(stored),
          occurredAt: now().toISOString(),
          depth: (frame.eventDepth ?? 0) + 1,
        };
        tx.outbox.push(envelope);
        const check = parseOwn(event.payload, payload, `${name} payload`).then(() => {});
        check.catch(() => {}); // surfaced at commit; never an unhandled rejection
        tx.pending.push(check);
      },
    };
  }
  const actionCtx = (frame: Frame, id: string): ActionCtx<any> => ({
    ...baseCtx(frame, id, ["query", "mutation", "action"]),
    signal: frame.signal,
    services,
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
            if (deliveries.length) await dispatcher.enqueue?.(txDb, deliveries);
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
    definitions: { functions, events, listeners },
    idOf,
    jobs: {
      run: (job, options) => deliver(job, options, keepFailed && ((error) => keepFailed(job, error))),
      sweep: async (options) => (await dispatcher.sweep?.(runner, options)) ?? { done: 0, failed: 0, discarded: 0, retrying: 0 },
      async retry(id) {
        if (!dispatcher.retry) throw new Error(`[logic-sdk] your jobs transport stores no jobs, so there's nothing to retry (${id}). outbox(db) does.`);
        return dispatcher.retry(id);
      },
    },
    [INTERNAL]: {
      options,
      config,
      derive: (more: Overrides) => build<S, Mods, Cf>(options, { ...o, ...more, config: mergeConfig(o.config, more.config) as object | undefined }),
    },
  };
}

/** @internal */
export const internal = <S extends object, Mods extends Record<string, object>, Cf>(registry: Registry<S, Mods, Cf>) => registry[INTERNAL];
