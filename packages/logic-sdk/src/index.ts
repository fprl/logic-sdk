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
  readonly description: string;
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
  /** The payload's schema, checked when emitted and again at delivery. */
  readonly payload: Schema;
  readonly description?: string;
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
}

export interface Listener<O = unknown> {
  readonly [BRAND]: "listener";
  readonly kind: "listener";
  /** Lazy, so listeners can import other modules' barrels without import cycles. */
  readonly event: () => EventDef<unknown, O>;
  readonly description?: string;
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
  event: Envelope<unknown, ScopeOf<C>> & { payload: O };
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
type Def<IS extends Schema, Ctx, R> = {
  /** One sentence, shown to humans, adapters and AI tools. */
  description: string;
  /** What callers pass, validated on every call. Leave it out when the function takes nothing. */
  input?: IS;
  handler: (ctx: Ctx, input: Out<IS>) => Promise<R>;
};
type NotExposed = { expose?: undefined };
type NoPolicy = { authorize?: undefined };
type WithMeta<C extends Config> = { meta?: MetaOf<C> };
type WithOutput<OS extends Schema> = { output: OS };

/**
 * `expose: true` needs `authorize` and `output`: you can't publish something without saying who may call it,
 * and what leaves your process is a contract. Internal functions may skip both; `authorize` still runs if set.
 */
interface Constructor<C extends Config, K extends Kind> {
  <IS extends Schema = NoInput, OS extends Schema = Schema, P extends Policy<ScopeOf<C>> = Policy<ScopeOf<C>>>(
    def: Def<IS, CtxOf<C, K, Guarded<P, ScopeOf<C>>>, In<OS>> &
      WithOutput<OS> &
      WithMeta<C> & { authorize: P; expose: true },
  ): Fn<K, In<IS>, Out<OS>, true>;
  <IS extends Schema = NoInput, OS extends Schema = Schema, P extends Policy<ScopeOf<C>> = Policy<ScopeOf<C>>>(
    def: Def<IS, CtxOf<C, K, Guarded<P, ScopeOf<C>>>, In<OS>> & WithOutput<OS> & WithMeta<C> & { authorize: P } & NotExposed,
  ): Fn<K, In<IS>, Out<OS>, false>;
  <IS extends Schema = NoInput, R = unknown, P extends Policy<ScopeOf<C>> = Policy<ScopeOf<C>>>(
    def: Def<IS, CtxOf<C, K, Guarded<P, ScopeOf<C>>>, R> & WithMeta<C> & { authorize: P } & NotExposed,
  ): Fn<K, In<IS>, R, false>;
  <IS extends Schema = NoInput, OS extends Schema = Schema>(
    def: Def<IS, CtxOf<C, K, ScopeOf<C>>, In<OS>> & WithOutput<OS> & WithMeta<C> & NoPolicy & NotExposed,
  ): Fn<K, In<IS>, Out<OS>, false>;
  <IS extends Schema = NoInput, R = unknown>(def: Def<IS, CtxOf<C, K, ScopeOf<C>>, R> & WithMeta<C> & NoPolicy & NotExposed): Fn<K, In<IS>, R, false>;
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
  database?: DatabaseAdapter<unknown, unknown>;
  services?: object;
  /** Settings every function reads as `ctx.config`. Plain data: it's copied and frozen. */
  config?: object;
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

type TypedOptions<C extends Config, Mods extends Record<string, object>> = Omit<RegistryOptions<Mods>, "wrap"> & {
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
 * export const { query, mutation, action, event, on, createRegistry } = init<Config>();
 * ```
 */
export function init<C extends Config & OnlyKnownKeys<C>>() {
  // One implementation behind the typed overloads of `Constructor`: the checks here are the runtime half of those types.
  const make =
    <K extends Kind>(kind: K) =>
    (def: any): any => {
      const where = def?.description ? `"${def.description}"` : `a ${kind}`;
      if (def.authorize !== undefined && typeof def.authorize !== "function")
        throw new Error(`[logic-sdk] authorize on ${where} must be a policy function, like \`authorize: member\`.`);
      if (def.expose !== undefined && def.expose !== true)
        throw new Error(`[logic-sdk] expose on ${where} must be \`true\` or left out.`);
      if (def.expose && !def.authorize)
        throw new Error(`[logic-sdk] ${where} has expose: true but no authorize. Say who may call it.`);
      if (def.expose && !def.output)
        throw new Error(`[logic-sdk] ${where} has expose: true but no output. Say what callers may see.`);
      if (typeof def.handler !== "function") throw new Error(`[logic-sdk] ${where} needs a handler(ctx, input).`);
      return Object.freeze({ [BRAND]: kind, kind, ...def });
    };

  return {
    /** Create the registry once at startup: `createRegistry({ modules, database, services })`. */
    createRegistry: <const Mods extends Record<string, object>>(options: TypedOptions<C, Mods>) =>
      build<ScopeOf<C>, Mods, ConfigOf<C>>(options as RegistryOptions<Mods>, {}), // meta in wrap is typed by MetaOf<C>; the values come from typed defs
    /** Reads data. Can run other queries. No writes, no events, no services. */
    query: make("query") as Constructor<C, "query">,
    /** Changes data inside one transaction. Can run queries and mutations (same transaction) and emit events. */
    mutation: make("mutation") as Constructor<C, "mutation">,
    /** Talks to the outside world (payments, email, AI). No transaction; each mutation it runs commits on its own. */
    action: make("action") as Constructor<C, "action">,
    /** Something that happened. Emitted by mutations, delivered after commit. */
    event: <S extends Schema>(def: { payload: S; description?: string }): EventDef<In<S>, Out<S>> =>
      Object.freeze({ [BRAND]: "event" as const, kind: "event" as const, ...def }),
    /** React to an event after commit, like an action. Must be idempotent. `on(() => bookings.confirmed, async (ctx, payload) => …)` */
    on: <O>(
      event: () => EventDef<unknown, O>,
      handler: (ctx: ListenerCtx<C, O>, payload: O) => Promise<unknown>,
      opts: { description?: string } = {},
    ): Listener<O> =>
      Object.freeze({
        [BRAND]: "listener" as const,
        kind: "listener" as const,
        event,
        description: opts.description,
        handler,
      }),
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
  events?: Dispatcher;
  now?: () => Date;
  stubs?: Map<Fn, (ctx: never, input: never) => Promise<unknown>>;
  record?: (envelope: Envelope) => void;
}

export interface RegisteredEvent extends Registered {
  event: EventDef;
}
export interface RegisteredListener extends Registered {
  listener: Listener;
  event: EventDef;
}

/** What `createRegistry` returns. `Cf` is your config's type, so tests can override parts of it. */
export interface Registry<S extends object = object, Mods extends Record<string, object> = Record<string, object>, Cf = unknown> {
  /** The modules you registered (typed), for adapters that build typed routers. */
  readonly modules: Mods;
  /** Bind who is calling, once per request, job or test: `const caller = registry.as(scope)`. */
  as(scope: S): Caller<S>;
  /** Everything the registry can do. Adapters read this. */
  readonly functions: readonly RegisteredFn[];
  readonly events: readonly RegisteredEvent[];
  readonly listeners: readonly RegisteredListener[];
  /** `"bookings.confirm"` for a registered function or event. Throws for anything unregistered. */
  idOf(fnOrEvent: object): string;
  /** Deliver one stored envelope to its listeners (durable dispatchers). Throws if any listener failed, so you can retry. */
  dispatch(envelope: Envelope): Promise<void>;
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

/**
 * A frozen copy of plain data: strings, numbers, booleans, null, plain objects and arrays. Anything else (a Date, a Map,
 * a client, a class) is rejected with its path, so settings can't change under everyone else or hide behavior.
 */
function freezeConfig(value: unknown, path = "config"): unknown {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((v, i) => freezeConfig(v, `${path}[${i}]`)));
  if (isPlain(value))
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freezeConfig(v, `${path}.${k}`)])));
  const what = typeof value === "function" ? "a function" : (value as object).constructor?.name ?? typeof value;
  throw new Error(
    `[logic-sdk] ${path} is ${what}. config holds plain data (strings, numbers, booleans, null, objects, arrays): ` +
      "pass a Date as an ISO string, and put clients in services.",
  );
}

const describeIssues = (issues: readonly StandardSchemaV1.Issue[]) =>
  issues.map((i) => ({ message: i.message, path: i.path?.map((p) => (typeof p === "object" ? p.key : p)) }));

const isBranded = (v: unknown): v is Fn | EventDef | Listener => !!v && typeof v === "object" && BRAND in v;

/**
 * What `createRegistry` finds in your modules, without a database or services: every function, event and
 * listener with its id. For tools (the CLI, docs generators) that inspect an app without running it.
 */
export function describeModules(modules: Record<string, object>) {
  const ids = new Map<object, string>();
  const functions: RegisteredFn[] = [];
  const events: RegisteredEvent[] = [];
  const listeners: RegisteredListener[] = [];

  for (const [module, ns] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(ns)) {
      if (!isBranded(value) || ids.has(value)) continue;
      const id = `${module}.${name}`;
      ids.set(value, id);
      if (value.kind === "event") events.push({ id, module, name, event: value });
      else if (value.kind === "listener") listeners.push({ id, module, name, listener: value, event: value.event() });
      else functions.push({ id, module, name, kind: value.kind, fn: value, exposed: value.expose === true });
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

  /** Run every listener for one envelope. Returns the failures instead of throwing. */
  async function runListeners(envelope: Envelope, eventDepth: number) {
    const failures: { listener: string; error: unknown }[] = [];
    const event = eventByName.get(envelope.name);
    for (const l of byEvent.get(envelope.name) ?? []) {
      const frame: Frame = { scope: envelope.scope, depth: 0, eventDepth };
      try {
        await wrap({ id: l.id, kind: "listener", meta: undefined, input: envelope.payload, scope: envelope.scope, depth: 0 }, async () => {
          const payload = event ? await parseOwn(event.payload, envelope.payload, `${envelope.name} payload`) : envelope.payload;
          return l.listener.handler({ ...actionCtx(frame, l.id), event: { ...envelope, payload } } as never, payload); // SAFETY: as in invoke
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
        const verdict: unknown = fn.authorize(frame.scope as never);
        if (verdict instanceof Promise)
          throw new Error(`[logic-sdk] The policy on ${id} returned a Promise. Policies are sync and read only the scope.`);
        if (verdict !== true) throw new DomainError("forbidden", `${id}.forbidden`);
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
      const eventDepth = (frame.eventDepth ?? 0) + 1;
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

  return {
    modules: options.modules,
    as: (scope) => ({
      scope,
      run: (fn: Fn, input?: unknown, options?: RunOptions) =>
        invoke(fn, input, enter({ scope, depth: -1 }, options), ["query", "mutation", "action"]), // depth 0
    }),
    functions,
    events,
    listeners,
    idOf,
    dispatch,
    [INTERNAL]: {
      options,
      config,
      derive: (more: Overrides) => build<S, Mods, Cf>(options, { ...o, ...more, config: mergeConfig(o.config, more.config) as object | undefined }),
    },
  };
}

/** @internal */
export const internal = <S extends object, Mods extends Record<string, object>, Cf>(registry: Registry<S, Mods, Cf>) => registry[INTERNAL];
