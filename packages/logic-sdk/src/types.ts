// The public types (re-exported from index.ts), the helper types the core shares, and the two symbols that brand
// definitions and hide the registry's internals.
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DomainError } from "./errors.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

export type Schema<I = any, O = any> = StandardSchemaV1<I, O>;
export type In<S> = S extends StandardSchemaV1<infer I, unknown> ? I : never;
export type Out<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

/** What you declare once in `init<...>()`. */
export interface Config {
  /** Who and where: actor, account, locale... Must be JSON-serializable (it travels with events). */
  scope: object;
  /**
   * Your database's type: `DrizzleDb<Db>`, or your own `ReadWrite<Reader, Tx>`. Queries get the reader, mutations the
   * transaction. A plain type is what both get.
   */
  db?: unknown;
  /** Side-effecting services (mailer, payments...). Only actions and listeners receive them. */
  services?: object;
  /**
   * Your app's settings, read as `ctx.config` in every function: base URL, limits, switches. Plain data, read-only.
   * Build it once from your env at the entry; clients built from secrets go in `services` instead.
   */
  config?: object;
  /**
   * The shape of `meta`: yours, plus what your adapters read (`AppMeta & AIMeta & PgBossMeta`). Yours goes on functions
   * and listeners, each adapter's only where it reads it.
   */
  meta?: object;
}
export type ScopeOf<C extends Config> = C["scope"];
declare const READ_WRITE: unique symbol;
/** A database type with two sides: what queries get and what mutations get. `DrizzleDb<Db>` is one. Type only. */
export interface ReadWrite<Reader, Tx> {
  readonly [READ_WRITE]: { reader: Reader; tx: Tx };
}
/** Says what's missing from the setup, where `never` would say nothing. */
interface SetupError<Message extends string> {
  readonly setupError: Message;
}
type NoDb = SetupError<"Add db to the Config you pass to init">;
/** What mutations get, and `database`'s transaction type. `never`: the app declared no database. */
export type DbOf<C extends Config> = C extends { db: infer D } ? (D extends ReadWrite<any, infer Tx> ? Tx : D) : never;
type ReaderOf<C extends Config> = C extends { db: infer D } ? (D extends ReadWrite<infer Reader, any> ? Reader : D) : NoDb;
type TxOf<C extends Config> = C extends { db: unknown } ? DbOf<C> : NoDb;
export type ServicesOf<C extends Config> = C extends { services: infer S } ? S : {};
type MetaOf<C extends Config> = C extends { meta: infer M } ? M : never;
declare const FOR_FUNCTIONS: unique symbol;
declare const FOR_LISTENERS: unique symbol;
/** An adapter's part of `meta`, read on queries, mutations and actions: `type AIMeta = ForFunctions<{ ai?: ... }>`. */
export interface ForFunctions<M> {
  readonly [FOR_FUNCTIONS]?: M;
}
/** An adapter's part of `meta`, read on listeners: `type PgBossMeta = ForListeners<{ pgBoss?: ... }>`. */
export interface ForListeners<M> {
  readonly [FOR_LISTENERS]?: M;
}
type AppPart<M> = { [P in keyof M as P extends symbol ? never : P]: M[P] };
type AdapterPart<M, S extends symbol> = S extends keyof M ? NonNullable<M[S]> : {};
/** `never` when nothing is left, or `{}` would take any object. */
type NeverIfEmpty<M> = keyof M extends never ? never : M;
/** A query, mutation or action's `meta`. */
export type FunctionMetaOf<C extends Config, M = MetaOf<C>> = M extends unknown
  ? NeverIfEmpty<AppPart<M> & AdapterPart<M, typeof FOR_FUNCTIONS>>
  : never;
/** A listener's `meta`. */
export type ListenerMetaOf<C extends Config, M = MetaOf<C>> = M extends unknown
  ? NeverIfEmpty<AppPart<M> & AdapterPart<M, typeof FOR_LISTENERS>>
  : never;
/** What `wrap` sees: it runs for both. */
export type CallMetaOf<C extends Config, M = MetaOf<C>> = M extends unknown
  ? NeverIfEmpty<AppPart<M> & AdapterPart<M, typeof FOR_FUNCTIONS> & AdapterPart<M, typeof FOR_LISTENERS>>
  : never;
/** Without a declared `config`, nothing may be passed or read: no silently ignored settings. */
export type ConfigOf<C extends Config> = C extends { config: infer F } ? F : Record<string, never>;

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
/** Brands every definer's result, so `createRegistry` finds them among a module's exports. */
export const BRAND: unique symbol = Symbol.for("logic-sdk.brand");

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
  /** Hops in the chain: 1 for an event a caller's mutation emitted, +1 each time a listener's mutation emits (or a call it schedules to run now). */
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
  /** Tries in total, stamped when it's queued, like Laravel's `maxTries` and Oban's `max_attempts`: a deploy that changes them applies to jobs queued after it. */
  attempts: number;
  /** When it may run (ISO), for a listener with a `delay`. Absent: right away. */
  runAt?: string;
}

/** One run of a cron: `id` is `<cron id>@<minute>` (`reports.weekly@20261123T0900Z`), so a tick runs once. */
export interface CronJob {
  kind: "cron";
  id: string;
  /** The cron's id, `"<module>.<id or export>"`. */
  cron: string;
  /** The minute it was due (ISO). */
  scheduledAt: string;
  /** Tries in total, stamped when it's queued, like Laravel's `maxTries` and Oban's `max_attempts`: a deploy that changes them applies to jobs queued after it. */
  attempts: number;
  /** When it may run (ISO), like a delivery's. Absent for crons: they run when ticked. */
  runAt?: string;
}

/** A function `ctx.schedule` asked to run later: `id` is `<function id>@<uuid>`, returned by `ctx.schedule`. */
export interface CallJob {
  kind: "call";
  id: string;
  /** The function's id, `"<module>.<id or export>"`. */
  fn: string;
  input: unknown;
  /** Who it runs as, as `jobs.scope.store` saved it (`load` rebuilds it when it runs). */
  scope: object;
  /** Tries in total, stamped when it's queued, like Laravel's `maxTries` and Oban's `max_attempts`: a deploy that changes them applies to jobs queued after it. */
  attempts: number;
  /**
   * Hops in the chain, counted with events' (`maxEventDepth`): a call due now continues the chain that scheduled it, so a
   * function that schedules itself with no delay stops like a listener loop. A delayed one starts a new chain (0).
   */
  depth: number;
  /** Its `replace` key: a newer call to `fn` with the same key replaces this one while it waits. */
  replace?: string;
  /** When it may run (ISO). */
  runAt?: string;
}

/**
 * One unit of background work, what `registry.jobs` runs, sweeps and retries: a listener's share of an event, a cron's
 * run, or a call `ctx.schedule` asked for.
 */
export type Job = Delivery | CronJob | CallJob;

/** A function to run on a schedule, as `scope`. Export it from a module, like listeners. */
export interface Cron {
  readonly [BRAND]: "cron";
  readonly kind: "cron";
  readonly id?: string;
  readonly schedule: string;
  readonly timezone?: string;
  readonly run: Fn;
  readonly input?: unknown;
  readonly scope: object;
  readonly attempts?: number;
}

/**
 * What running a job resolved to. `failed`: out of attempts, a rule said no (`invalid`, `unauthenticated`, `forbidden`,
 * `not_found`, `rejected`), the payload no longer matches its schema, or this code can't run it (renamed, removed, an
 * unknown kind). Retrying can't help, so acknowledge it; it's been reported.
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
  db: TxOf<C>;
  /**
   * Call a query or mutation inside this same transaction, with its policy and validation:
   * `await ctx.run(availability.hold, { propertyId })`. If it fails, the whole transaction rolls back.
   */
  run: Run<"query" | "mutation", ScopeOf<C>>;
  /** Queue an event. Delivered to listeners only after the transaction commits. */
  emit<I>(event: EventDef<I, unknown>, payload: I): void;
  /**
   * Run a mutation or action once, later, as this scope: `ctx.schedule(guests.remind, { bookingId }, { at })` or
   * `{ delay: 3600 }` (seconds). Committed with this transaction, so a rollback never leaves one behind. Returns its job
   * id. It runs whatever happens meanwhile, so it should check that its reason still holds ("still confirmed?").
   * `attempts`: tries in total, default 1; give an action that calls an API a few. `replace`: a key, so a newer call
   * with it replaces the one still waiting (`replace: booking.id` when the dates change), like Oban's `replace`.
   */
  schedule<F extends Fn<"mutation" | "action">>(fn: F, input: FnIn<F>, options: ScheduleOptions): string;
}
/** When a scheduled call runs (`at` or `delay` in seconds), and how many tries it gets. */
export type ScheduleOptions = ({ at: Date; delay?: never } | { delay: number; at?: never }) & {
  attempts?: number;
  /** A key: the call to this function waiting with the same key (not started yet) is replaced by this one. */
  replace?: string;
};
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
  meta?: FunctionMetaOf<C>;
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
export type Constructor<C extends Config, K extends Kind> = <
  IS extends Schema = NoInput,
  OS extends Schema | undefined = undefined,
  R = unknown,
  P extends Policy<ScopeOf<C>> = Policy<ScopeOf<C>>,
  X extends true | undefined = undefined,
>(
  def: Def<C, K, IS, OS, R, P> & Exposure<C, OS, X>,
) => Fn<K, In<IS>, [OS] extends [Schema] ? Out<OS> : R, [X] extends [true] ? true : false>;

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

/** Runs one job: resolves when it's done or failed for good (acknowledge it), throws when a retry might help. */
export type RunJob = (job: Job, options?: RunJobOptions) => Promise<DeliveryOutcome>;

export interface RunJobOptions {
  /** 1 on the first try; the adapter counts. */
  attempt?: number;
  /**
   * Called with the error when the job fails for good, before `run` resolves `"failed"`: keep it. Default: the adapter's
   * `fail` (the outbox writes a failed row).
   */
  fail?: (error: unknown) => Promise<void>;
}

/** What a sweep did: done, failed for good, discarded (`jobs.scope.load` returned null), or put back with a backoff. */
export interface SweepResult {
  done: number;
  failed: number;
  discarded: number;
  retrying: number;
}

/** What the registry hands an adapter: run a job here, or report a failure of the adapter's own (a send that failed). */
export interface Runner {
  /** Every failure it meets is already reported to `onError`; a throw means "retry it". */
  run: RunJob;
  report(error: unknown, job: Job, attempt?: number): void;
}

export interface Dispatcher {
  /**
   * It can hold a job until its `runAt` (a listener's `delay`, `ctx.schedule`): `true`, or for at most `max` seconds.
   * Without it (`inProcess()`), `createRegistry` refuses delayed listeners and `ctx.schedule` throws, rather than run
   * them early or lose them.
   */
  holds?: true | { max: number };
  /**
   * Can replace a call waiting to run: `enqueue` gets a call with `replace`, and a pending call to the same `fn` with
   * the same key that hasn't started is replaced by it. The outbox can; a queue that already has the message can't.
   * Without it, `ctx.schedule` with `replace` is refused.
   */
  replaces?: true;
  /** At `createRegistry`: refuse a setup this adapter can't honour (a database it doesn't share). */
  check?(setup: { listeners: readonly RegisteredListener[]; database: DatabaseAdapter<unknown, unknown> | undefined }): void;
  /** Inside the transaction, before commit. In-process: nothing. Outbox: insert one row per delivery with `tx`. */
  enqueue?(tx: unknown, jobs: Job[]): Promise<void>;
  /** After commit: run them, or hand them to a queue. A throw is reported to `onError`. */
  deliver(jobs: Job[], runner: Runner): Promise<void>;
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

/**
 * What `onError` gets with a failure after commit. `job`, `attempt` and `outcome` are set when a job failed: the job
 * itself, like Laravel's `JobFailed` and Oban's exception telemetry.
 */
export interface FailureInfo {
  /** The listener, cron or scheduled function that failed, or the part of the registry (`"(dispatcher)"`). */
  source: string;
  /** The job that failed, or that the adapter couldn't take (`"(dispatcher)"`). */
  job?: Job;
  attempt?: number;
  /** `retry`: tries are left and the adapter may run it again. `failed` and `discarded`: it's over. */
  outcome?: "retry" | "failed" | "discarded";
}

/**
 * Who a job runs as, at rest. `store` picks what's saved with the job (ids, not whole objects); `load` rebuilds the
 * scope when it runs, so policies see today's roles. `load` returning null discards the job (reported to `onError`),
 * a throw retries it. By default the scope is stored as it was at emit. `store` needs `load`: listeners run as a scope,
 * not as what was saved. Every adapter but `inProcess()` keeps jobs to run later, so it needs `load`: `createRegistry` checks.
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
  /** Background work: `jobs: { adapter: outbox(db), scope: { store, load } }`. Default: in-process, scope as-is (nothing waits). */
  jobs?: JobsOptions;
  /** Wraps every call, including ones that fail validation or authorization: logging, tracing, audit. */
  wrap?: (call: Call, next: () => Promise<unknown>) => Promise<unknown>;
  /**
   * Serverless: let listeners finish after the response. Pass the platform's global:
   * `import { waitUntil } from "cloudflare:workers"` or `import { waitUntil } from "@vercel/functions"`.
   * Without it, `run` waits for listeners. On a long-lived server with the outbox, `() => {}` answers first (a restart
   * is swept up after its lease: retried, or failed when it was out of attempts); with `inProcess()`, don't: work
   * still running at a restart is lost.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Failures after commit land here (listeners, dispatcher). They never fail the caller. */
  onError?: (error: unknown, info: FailureInfo) => void;
  now?: () => Date;
  /**
   * Max chain of listener → mutation → event → listener… before queueing stops, reported. Calls `ctx.schedule` runs
   * right away count too, so a function that schedules itself with no delay stops the same way. Default 8 (real chains
   * are 2 or 3).
   */
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

export interface Overrides {
  database?: DatabaseAdapter<unknown, unknown>;
  services?: object;
  /** Merged over the registry's config, section by section. */
  config?: unknown;
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
export interface RegisteredCron extends Registered {
  cron: Cron;
}

/** `registry.jobs`: what you call from a queue consumer, a cron, or a script. */
export interface Jobs {
  /**
   * Run one stored job (queue consumers): `await registry.jobs.run(message.body, { attempt: message.attempts })`.
   * Resolves `"done"`, `"failed"` or `"discarded"` (acknowledge all three); throws when a retry might help and the
   * job has tries left. A `failed` job goes to `fail`: yours, or your adapter's (the outbox keeps it).
   */
  run(job: Job, options?: RunJobOptions): Promise<DeliveryOutcome>;
  /**
   * Run the crons due in `at`'s minute (default now), from a timer or your platform's cron trigger:
   * `await registry.jobs.tick(new Date(controller.scheduledTime))`. Resolves the ids of the crons that were due. Each run
   * goes through your jobs adapter, and with `outbox(db)` a minute that's ticked twice still runs each cron once.
   */
  tick(at?: Date): Promise<string[]>;
  /**
   * Run what your adapter has due, from a cron or an interval: `await registry.jobs.sweep()`. With `outbox(db)`, that's
   * retries whose backoff is over and jobs whose runner crashed. Adapters that keep nothing, or maintain themselves
   * (pg-boss), resolve zeros.
   */
  sweep(options?: { limit?: number }): Promise<SweepResult>;
  /**
   * Put a failed job back in line with a fresh set of attempts. `false` when no failed job has that id (it's pending,
   * running, done, or never existed). Throws when your adapter keeps no jobs, like `inProcess()`.
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
    readonly crons: readonly RegisteredCron[];
  };
  /** `"bookings.confirm"` for a registered function or event. Throws for anything unregistered. */
  idOf(fnOrEvent: object): string;
  /** The background work your `jobs` adapter holds. */
  readonly jobs: Jobs;
  /** @internal used by `logic-sdk/testing` */
  readonly [INTERNAL]: {
    options: RegistryOptions<Mods>;
    config: Frozen<Cf>;
    derive(more: Overrides): Registry<S, Mods, Cf>;
    /** An event as `emit` would make it, for `t.jobs.perform`. */
    envelope(event: EventDef, payload: unknown, scope: S): Envelope;
    /** The cron runs due in a minute, for `t.jobs.tick`. */
    due(at: Date): CronJob[];
  };
}

/** The registry's internals, for `logic-sdk/testing`. */
export const INTERNAL: unique symbol = Symbol.for("logic-sdk.internal");
