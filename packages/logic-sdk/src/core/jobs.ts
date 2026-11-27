import { CaughtNestedFailure, describeIssues, isDomainError, StalePayload } from "./errors.ts";
import { isDue, parseSchedule } from "./schedule.ts";
import type {
  ActionCtx,
  AdapterSetup,
  Call,
  CallJob,
  CronJob,
  DatabaseAdapter,
  Delivery,
  FailedJobs,
  Envelope,
  FailureInfo,
  Fn,
  Job,
  JobOutcome,
  JobsAdapter,
  JobScope,
  Jobs,
  CronRun,
  ListenerEvent,
  LoadCtx,
  LocalWorker,
  RegisteredCron,
  RegisteredFn,
  RegisteredListener,
  RunJobOptions,
  Runner,
  ScopeMatch,
} from "./types.ts";

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * JSON with object keys sorted, so `{ a, b }` and `{ b, a }` are one input, like TanStack Query's `hashKey`. Undefined
 * properties drop out, as in JSON; array order counts. The input as passed, before its schema runs (defaults aren't
 * applied), so a schema change doesn't move what's waiting.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (isPlainObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v)) ?? "";

/**
 * What makes a scheduled call with `replace: true` replaceable: its function and its input, `<function id>@<input>`. A
 * newer call with the same one replaces it while it waits. Undefined for every other job.
 */
export const replaceKeyOf = (job: Job): string | undefined => (job.kind === "call" && job.replace ? `${job.fn}@${canonical(job.input)}` : undefined);

/**
 * The key adapters that keep one waiting job per key (`replaces: true`) store: a delivery's `unique` as it is, a call's
 * `replaceKeyOf` as `<function id>@<sha-256 of the input>`, so a large input still fits an index and the function
 * stays readable. Undefined for every other job.
 */
export async function storedUniqueKey(job: Job): Promise<string | undefined> {
  if (job.kind === "delivery") return job.unique;
  if (job.kind !== "call" || !job.replace) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(job.input)));
  return `${job.fn}@${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A `failed({ scope })` filter as the fields it matches: `{ organization: { id: "o1" } }` is `organization.id = "o1"`.
 * Strings, numbers, booleans and null; never an array or an empty object, which two databases would read differently.
 */
function scopeMatches(filter: unknown): ScopeMatch[] {
  const out: ScopeMatch[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      out.push({ path, value });
      return;
    }
    const where = path.length ? path.join(".") : "scope";
    if (!isPlainObject(value))
      throw new Error(`[logic-sdk] jobs.failed({ scope }) matches strings, numbers, booleans and null: ${where} is ${Array.isArray(value) ? "an array" : typeof value}.`);
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (!keys.length) throw new Error(`[logic-sdk] jobs.failed({ scope }) matches fields: ${where} is an empty object.`);
    for (const k of keys) walk(value[k], [...path, k]);
  };
  walk(filter, []);
  return out;
}

/**
 * Seconds to wait after a failed try: e^attempt, capped at e^10 (about 6 hours), the curve Graphile Worker uses. The
 * core's, so every adapter that backs off (the jobs table, Cloudflare's redelivery) waits the same.
 */
export const defaultBackoff = (attempt: number) => Math.exp(Math.min(attempt, 10));

/** Where the docs list each adapter and what it can do. */
export const ADAPTERS = "see Jobs, Adapters in the docs";

/** The loops running each adapter's jobs in this process (`work()`), by adapter: every registry on it shares them. */
const localWorkers = new WeakMap<JobsAdapter, Set<LocalWorker>>();
const workerSet = (adapter: JobsAdapter) => {
  let set = localWorkers.get(adapter);
  if (!set) localWorkers.set(adapter, (set = new Set()));
  return set;
};
/** What an adapter's `connect` gets as `setup.workers`: does a loop here take this job, and wake them. */
export function workersOf(adapter: JobsAdapter): AdapterSetup["workers"] {
  const set = workerSet(adapter);
  return {
    takes: (job) => [...set].some((w) => !w.queues || w.queues.includes(job.queue ?? "default")),
    wake: (count) => {
      for (const worker of set) worker.wake(count);
    },
  };
}

/** The minute `at` falls in, and its stamp for a job id: `20261123T0900Z` (no `:`, which BullMQ rejects). */
function minuteOf(at: Date, what: string) {
  if (Number.isNaN(at.getTime())) throw new Error(`[logic-sdk] ${what} needs a valid date (got ${String(at)}).`);
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  return { minute, stamp: minute.toISOString().slice(0, 16).replaceAll(/[-:]/g, "") + "Z" };
}

/** One listener's share of an event, as a job: `<listener id>@<event id>`, with the listener's tries. */
export const deliveryOf = (l: RegisteredListener, e: Envelope): Delivery => ({
  kind: "delivery",
  id: `${l.id}@${e.id}`,
  listener: l.id,
  envelope: e,
  attempts: l.listener.attempts ?? 1,
});

/**
 * A try that runs past its timeout: aborts its signal (its `ctx.signal`, and no new `ctx.run` starts) and fails the try,
 * as Laravel's `$timeout` and Oban's `timeout/1` count it. JavaScript can't kill it, so what it still does is ignored.
 */
async function stopAfter<T>(work: Promise<T>, seconds: number, stop: AbortController, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`[logic-sdk] ${why}`);
      stop.abort(error);
      reject(error);
    }, seconds * 1000);
  });
  work.catch(() => {}); // it may still settle after the timeout: not this try's anymore
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** What running jobs needs from the registry: its definitions, and how it runs a function or a listener's handler. */
export interface JobsDeps {
  listeners: readonly RegisteredListener[];
  crons: readonly RegisteredCron[];
  functions: readonly RegisteredFn[];
  idOf(x: object): string;
  jobsAdapter: JobsAdapter;
  database: DatabaseAdapter<unknown, unknown> | undefined;
  jobScope: JobScope | undefined;
  /** `jobs.failed`: where failed jobs are kept when the adapter keeps none. */
  failedStore: FailedJobs | undefined;
  maxEventDepth: number;
  /** `jobs.queues`: the queues besides `"default"`. */
  queues: readonly string[];
  now(): Date;
  wrap(call: Call, next: () => Promise<unknown>): Promise<unknown>;
  report(error: unknown, info: FailureInfo): void;
  /** Run a function as `scope`, like `registry.as(scope).run`. `eventDepth`: the chain's hops so far (a scheduled call's `depth`). */
  runAs(fn: Fn, input: unknown, scope: object, eventDepth: number, queued: Job[] | undefined, job: { id: string; attempt: number }): Promise<unknown>;
  /** The ctx a listener's or cron's handler gets, as `scope`, in an event chain `eventDepth` deep. `stop`: its timeout. */
  handlerCtx(scope: object, eventDepth: number, id: string, queued: Job[] | undefined, stop?: AbortSignal): ActionCtx<any>;
  /** What `jobs.scope.load` gets first: the registry's database (a test's transaction in tests) and config. */
  loadCtx(): LoadCtx;
}

/**
 * Jobs, for one registry: a listener's share of an event, a cron's run, a scheduled call. Turns a commit's events and
 * calls into jobs, runs one (with its tries), and is what `registry.jobs` calls.
 */
export function makeJobs(deps: JobsDeps) {
  const { listeners, crons, functions, idOf, jobsAdapter, database, jobScope, failedStore, maxEventDepth, queues, now, wrap, report, runAs, handlerCtx, loadCtx } = deps;
  /** Your adapter, as messages name it: by what it can't do, and by its own name. */
  const yours = jobsAdapter.name ? `your jobs adapter, ${jobsAdapter.name},` : "your jobs adapter";

  // ── queues ───────────────────────────────────────────────────────────────
  for (const q of queues)
    if (typeof q !== "string" || !q || q === "default") throw new Error(`[logic-sdk] jobs.queues takes names besides "default" (got ${JSON.stringify(q)}).`);
  if (new Set(queues).size !== queues.length) throw new Error(`[logic-sdk] jobs.queues lists a queue twice: ${queues.join(", ")}.`);
  const queueNames = ["default", ...queues];
  if (queues.length && !jobsAdapter.queues)
    throw new Error(`[logic-sdk] jobs.queues declares ${queues.join(", ")}, but ${yours} keeps every job in one queue. Use one that keeps them apart (${ADAPTERS}).`);
  if (typeof jobsAdapter.queues === "object")
    for (const q of queueNames)
      if (!jobsAdapter.queues.includes(q)) throw new Error(`[logic-sdk] ${yours} has no queue for "${q}": give it one (it has ${jobsAdapter.queues.join(", ") || "none"}).`);
  /** A queue someone named: one of `jobs.queues`, or `"default"`. */
  function checkQueue(what: string, queue: string | undefined) {
    if (queue !== undefined && !queueNames.includes(queue))
      throw new Error(`[logic-sdk] ${what} has queue ${JSON.stringify(queue)}, which jobs.queues doesn't declare (${queueNames.join(", ")}).`);
  }
  for (const l of listeners) checkQueue(l.id, l.listener.queue);
  for (const c of crons) checkQueue(c.id, c.cron.queue);
  if (failedStore && jobsAdapter.failed) throw new Error(`[logic-sdk] ${yours} keeps failed jobs itself, so jobs.failed has nothing to keep: drop it.`);
  const enqueue = jobsAdapter.enqueue?.bind(jobsAdapter);
  if (enqueue && crons.length && !database)
    throw new Error(`[logic-sdk] Crons need \`database\` with ${yours}: their runs are written in a transaction of their own.`);
  /** Cron runs, queued in a transaction of their own (a stored adapter runs each minute once there). */
  const enqueueAlone = async (jobs: Job[]) => {
    if (enqueue && database) await database.transaction((tx) => enqueue(tx, jobs));
  };

  // ── listeners ────────────────────────────────────────────────────────────
  const byEvent = new Map<string, RegisteredListener[]>();
  for (const l of listeners) {
    const name = idOf(l.event);
    byEvent.set(name, [...(byEvent.get(name) ?? []), l]);
  }

  const listenerById = new Map(listeners.map((l) => [l.id, l]));

  const scheduled = crons.map((c) => ({ ...c, schedule: parseSchedule(c.cron.schedule) }));
  const cronById = new Map(crons.map((c) => [c.id, c]));
  const fnById = new Map(functions.map((f) => [f.id, f]));

  /**
   * A job that waits (a listener's `delay`, `ctx.schedule`) needs an adapter that holds it: run early it'd be wrong,
   * kept in memory it'd be lost on restart. Laravel's sync queue drops the delay; we refuse instead.
   */
  function checkHold(what: string, seconds: number) {
    const { holds } = jobsAdapter;
    if (!holds) throw new Error(`[logic-sdk] ${what} waits ${seconds}s, but ${yours} can't hold jobs. Use one that holds them (${ADAPTERS}).`);
    if (holds !== true && seconds > holds.max)
      throw new Error(`[logic-sdk] ${what} waits ${seconds}s; ${yours} holds jobs for at most ${holds.max}s. Use one that holds them longer, or a jobs table in front of it (${ADAPTERS}).`);
  }
  /** `attempts` above 1 need an adapter that runs a job again: ignored, a failure would just be lost. Rails' inline adapter refuses too. */
  function checkRetries(what: string, attempts: number) {
    if (attempts > 1 && !jobsAdapter.retries)
      throw new Error(`[logic-sdk] ${what} has attempts: ${attempts}, but ${yours} runs each job once. Use one that retries (${ADAPTERS}), or attempts: 1.`);
  }
  for (const l of listeners) if (l.listener.delay) checkHold(l.id, l.listener.delay);
  for (const l of listeners) checkRetries(l.id, l.listener.attempts ?? 1);
  for (const c of crons) checkRetries(c.id, c.cron.attempts ?? 1);
  for (const l of listeners) {
    if (l.listener.key && !jobsAdapter.orders)
      throw new Error(`[logic-sdk] ${l.id} has a key, but ${yours} can't run jobs one at a time by key. Use one that can (see Jobs, "key" in the docs).`);
    // nothing waits on an adapter that runs jobs at once, so there's nothing to drop
    if (l.listener.unique && jobsAdapter.holds && !jobsAdapter.replaces)
      throw new Error(`[logic-sdk] ${l.id} is unique, but ${yours} can't drop a job it already has. Use one that can (see Jobs, "unique" in the docs).`);
  }

  /**
   * What a commit queues: one delivery per listener of each event that its `when` lets through, and the calls it
   * scheduled. Events and calls due now past `maxEventDepth` (a listener loop, a function scheduling itself with no
   * delay) are dropped, reported once.
   */
  function toJobs(envelopes: Envelope[], calls: CallJob[], parsed: Map<Envelope, unknown>): Job[] {
    /** Its `when`, if any. A throw is a bug in the app: it fails the mutation, naming the listener. */
    const wants = (l: RegisteredListener, e: Envelope, payload: unknown) => {
      try {
        return !l.listener.when || l.listener.when(payload);
      } catch (error) {
        throw new Error(`[logic-sdk] ${l.id}'s when threw on ${e.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    };
    /** Its `key` or `unique`, as `<listener id>@<value>`. A throw or an empty value is a bug in the app: it fails the mutation. */
    const valueOf = (l: RegisteredListener, option: "key" | "unique", e: Envelope, payload: unknown) => {
      const of = l.listener[option];
      if (!of) return undefined;
      let value: unknown;
      try {
        value = of(payload);
      } catch (error) {
        throw new Error(`[logic-sdk] ${l.id}'s ${option} threw on ${e.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (typeof value !== "string" || !value) throw new Error(`[logic-sdk] ${l.id}'s ${option} must return a non-empty string (got ${JSON.stringify(value)}) on ${e.name}.`);
      return `${l.id}@${value}`;
    };
    const fits = (job: { depth: number }) => job.depth <= maxEventDepth;
    const deepEvent = envelopes.find((e) => !fits(e));
    const deepCall = calls.find((c) => !fits(c));
    const loop = (what: string) => new Error(`[logic-sdk] chain of events and calls deeper than ${maxEventDepth} (jobs.maxEventDepth): stopped queueing ${what} (a loop?)`);
    if (deepEvent) report(loop(deepEvent.name), { source: deepEvent.name });
    else if (deepCall) report(loop(deepCall.fn), infoOf(deepCall));
    const unique = new Set<string>();
    const deliveries = envelopes.filter(fits).flatMap((e) =>
      (byEvent.get(e.name) ?? []).filter((l) => wants(l, e, parsed.get(e))).flatMap((l): Delivery[] => {
        const job = deliveryOf(l, e);
        const delay = l.listener.delay;
        if (delay) job.runAt = new Date(Date.parse(e.occurredAt) + delay * 1000).toISOString();
        const key = valueOf(l, "key", e, parsed.get(e));
        if (key) job.key = key;
        if (l.listener.queue) job.queue = l.listener.queue;
        job.unique = valueOf(l, "unique", e, parsed.get(e));
        if (!job.unique) return [job];
        if (unique.has(job.unique)) return []; // the same commit's first one waits; adapters drop later commits' ones
        unique.add(job.unique);
        return [job];
      }),
    );
    return [...deliveries, ...calls.filter(fits)];
  }

  /** An adapter that couldn't take a commit's jobs: each one may be lost, so each is reported. */
  const reportEach = (error: unknown, jobs: Job[]) => {
    for (const job of jobs) report(error, { source: "(jobs adapter)", job });
  };

  /** What `onError` hears about a job. */
  const infoOf = (job: Job, attempt?: number): FailureInfo =>
    job.kind === "delivery"
      ? { source: job.listener, job, attempt }
      : { source: job.kind === "cron" ? job.cron : job.fn, job, attempt };

  /** Who a stored job runs as: `jobs.scope.load` rebuilds it; null means discard it (reported). */
  async function scopeOf(job: Job, stored: object, attempt: number): Promise<object | null> {
    if (!jobScope?.load) return stored;
    const loaded = await jobScope.load(loadCtx(), stored);
    if (loaded === undefined) throw new Error(`[logic-sdk] jobs.scope.load returned undefined for ${job.id}. Return the scope, or null to discard the job.`);
    if (loaded === null) report(new Error(`[logic-sdk] jobs.scope.load returned null for ${job.id}, so it was discarded.`), { ...infoOf(job, attempt), outcome: "discarded" });
    return loaded;
  }

  /**
   * Run one job: a listener's share of an event, a cron's run, or a scheduled call. Reports every failure; throws only when a retry might
   * help and there are tries left. `fail` keeps a job that failed for good. The jobs it queues land in `queued`, for
   * `deliver` to run once this one is settled; without it (`registry.jobs.run`, in a consumer) they're delivered at once.
   */
  async function runJob(job: Job, { attempt = 1, fail }: RunJobOptions = {}, queued?: Job[]): Promise<JobOutcome> {
    const info = infoOf(job, attempt);
    // read before narrowing: a job queued by another version can have a kind this one doesn't know
    const { id, kind }: { id: string; kind: string } = job;
    /** Its definition's `failed`, once its last try failed: after it's kept, at most once. A throw is reported. */
    let afterFailed: ((error: unknown) => Promise<unknown>) | undefined;
    const failed = async (error: unknown) => {
      report(error, { ...info, outcome: "failed" });
      await fail?.(error);
      if (afterFailed)
        await afterFailed(error).catch((e) => report(e, { source: `${info.source} (failed)`, job, attempt }));
      return "failed" as const;
    };
    /** One try of the job's `attempts`. */
    const attemptOnce = async (work: () => Promise<JobOutcome>): Promise<JobOutcome> => {
      const { attempts } = job;
      // its last try was claimed but never finished: a crash, or slower than the lease (Laravel checks this too)
      if (attempt > attempts)
        return failed(
          new Error(`[logic-sdk] ${job.id} has used its ${attempts} attempt(s): the last one never finished (crashed or outlived the lease), or its result wasn't recorded.`),
        );
      try {
        return await work();
      } catch (error) {
        // a caught nested failure is retried as its cause would be: a swallowed `reject` still fails at once
        const decisive = error instanceof CaughtNestedFailure ? error.cause : error;
        const retrying = attempt < attempts && !(decisive instanceof StalePayload) && !(isDomainError(decisive) && decisive.kind !== "conflict");
        if (!retrying) return failed(error);
        report(error, { ...info, outcome: "retry" });
        throw error;
      }
    };

    // code this process doesn't have (renamed, removed, or not deployed here yet) is a try like any other, as Laravel
    // treats a missing class: in a rolling deploy the new code gets a later one.
    const cantRun = (why: string) =>
      attemptOnce(async () => {
        throw new Error(`[logic-sdk] ${why}`);
      });
    const missing = (what: string, id: string) =>
      cantRun(`${id} isn't a registered ${what} (renamed, removed or not deployed here yet?), so job ${job.id} can't run.`);
    if (job.kind === "cron") {
      const c = cronById.get(job.cron);
      if (!c) return missing("cron", job.cron);
      const run: CronRun = { id: c.id, scheduledAt: job.scheduledAt, attempt };
      const hook = c.cron.failed;
      if (hook) afterFailed = (error) => hook({ ...handlerCtx(c.cron.scope, 0, c.id, queued), cron: run } as never, error); // SAFETY: as below
      return attemptOnce(async () => {
        // its scope comes from the code each time, never stored, so jobs.scope store and load don't apply
        const { scope, meta, handler } = c.cron;
        await wrap({ id: c.id, kind: "cron", job: { id: job.id, attempt }, meta, input: undefined, scope, depth: 0 }, () =>
          handler({ ...handlerCtx(scope, 0, c.id, queued), cron: run } as never), // SAFETY: as for listeners: the ctx was built for a cron
        );
        return "done";
      });
    }
    if (job.kind === "call") {
      const f = fnById.get(job.fn);
      if (!f) return missing("function", job.fn);
      return attemptOnce(async () => {
        const scope = await scopeOf(job, job.scope, attempt);
        if (!scope) return "discarded";
        await runAs(f.fn, job.input, scope, job.depth, queued, { id: job.id, attempt });
        return "done";
      });
    }
    if (job.kind !== "delivery") return cantRun(`job ${id} has kind ${JSON.stringify(kind)}, which this version can't run.`);
    const l = listenerById.get(job.listener);
    if (!l) return missing("listener", job.listener);
    const { envelope } = job;
    const { timeout } = l.listener;
    const stop = timeout ? new AbortController() : undefined;
    const hook = l.listener.failed;
    // with today's scope and the parsed payload, as its handler would get them; a stale job or a scope that's gone has neither
    if (hook)
      afterFailed = async (error) => {
        if (error instanceof StalePayload) return;
        const scope = jobScope?.load ? await jobScope.load(loadCtx(), envelope.scope) : envelope.scope;
        const r = await l.event.payload["~standard"].validate(envelope.payload);
        if (!scope || r.issues || idOf(l.event) !== envelope.name) return;
        const ctxEvent: ListenerEvent = { id: envelope.id, name: envelope.name, payload: r.value, occurredAt: envelope.occurredAt, attempt };
        return hook({ ...handlerCtx(scope, envelope.depth, l.id, queued), event: ctxEvent } as never, r.value, error); // SAFETY: as the handler's
      };
    return attemptOnce(async () => {
      const scope = await scopeOf(job, envelope.scope, attempt);
      if (!scope) return "discarded";
      const handled = wrap({ id: l.id, kind: "listener", job: { id: job.id, attempt }, meta: l.listener.meta, input: envelope.payload, scope, depth: 0 }, async () => {
        // its listener's event now: one renamed without an `id`, or a listener moved to another event, leaves stale jobs
        if (idOf(l.event) !== envelope.name)
          throw new StalePayload(`[logic-sdk] ${l.id} now listens to ${idOf(l.event)}, and this job is for ${envelope.name}.`);
        const r = await l.event.payload["~standard"].validate(envelope.payload);
        if (r.issues) throw new StalePayload(`[logic-sdk] ${envelope.name} payload no longer matches its schema: ${JSON.stringify(describeIssues(r.issues))}`);
        const payload = r.value;
        const ctxEvent: ListenerEvent = { id: envelope.id, name: envelope.name, payload, occurredAt: envelope.occurredAt, attempt };
        return l.listener.handler({ ...handlerCtx(scope, envelope.depth, l.id, queued, stop?.signal), event: ctxEvent } as never, payload); // SAFETY: as in registry.ts's invoke: the ctx was built for a listener
      });
      await (timeout && stop ? stopAfter(handled, timeout, stop, `${l.id} ran past its timeout of ${timeout}s, so this try was stopped.`) : handled);
      return "done";
    });
  }

  /** A runner whose jobs' own jobs are collected in `queued`. */
  const runnerInto = (queued: Job[]): Runner => ({
    // a job the adapter runs here and doesn't record itself (inProcess) is kept by the store, if there's one
    run: (job, options) => runJob(job, { ...options, fail: options?.fail ?? (failedStore && ((error) => failedStore.fail(job, error))) }, queued),
    report: (e, job, attempt) => report(e, infoOf(job, attempt)),
  });

  /**
   * Deliver jobs, then the jobs those queued, and so on. A job is settled before what it queued starts, as a Laravel
   * worker deletes a job before it pops the ones it pushed: a crash in a follow-up can't run the job again.
   */
  async function deliver(jobs: Job[]) {
    while (jobs.length) {
      const batch = jobs;
      jobs = [];
      await jobsAdapter.deliver(batch, runnerInto(jobs)).catch((e) => reportEach(e, batch));
    }
  }

  /**
   * The runs due in `at`'s minute: one job per cron, with an id per minute, so a tick that's delivered twice runs once.
   * With `only`, that cron's run for the minute, due or not (`t.jobs.perform`).
   */
  function due(at: Date, only?: string): CronJob[] {
    const { minute, stamp } = minuteOf(at, "tick");
    return scheduled
      .filter((c) => (only === undefined ? isDue(c.schedule, minute, c.cron.timezone) : c.id === only))
      .map((c) => ({ kind: "cron", id: `${c.id}@${stamp}`, cron: c.id, scheduledAt: minute.toISOString(), attempts: c.cron.attempts ?? 1, ...(c.cron.queue ? { queue: c.cron.queue } : {}) }));
  }

  const jobs: Jobs = {
    async run(job, options) {
      // a signal: the adapter's row says what runs, and records how it went
      if (jobsAdapter.consume) {
        const queued: Job[] = [];
        await jobsAdapter.consume(job, runnerInto(queued)).catch((error) => {
          report(error, { source: "(jobs adapter)", job }); // the consumer retries the message: nothing else hears of it
          throw error;
        });
        await deliver(queued);
        return "done";
      }
      return runJob(job, { attempt: options?.attempt, fail: failedStore && ((error) => failedStore.fail(job, error)) });
    },
    async tick(at = now()) {
      const jobs = due(at);
      if (!jobs.length) return [];
      await enqueueAlone(jobs);
      await deliver(jobs);
      return jobs.map((job) => job.cron);
    },
    async sweep(options) {
      for (const q of options?.queues ?? []) checkQueue("jobs.sweep({ queues })", q);
      const queued: Job[] = [];
      const result = (await jobsAdapter.sweep?.(runnerInto(queued), options)) ?? { done: 0, failed: 0, discarded: 0, retrying: 0 };
      await deliver(queued);
      return result;
    },
    attach(worker) {
      for (const q of worker.queues ?? []) checkQueue("A worker", q);
      const set = workerSet(jobsAdapter);
      set.add(worker);
      return () => void set.delete(worker);
    },
    async retry(id) {
      if (jobsAdapter.retry) return jobsAdapter.retry(id);
      if (!failedStore) throw new Error(`[logic-sdk] ${yours} keeps no failed jobs, so there's nothing to retry (${id}). Use one that keeps them, or jobs.failed (${ADAPTERS}).`);
      // out of the store, back to the queue with a fresh set of tries; a hand-off that fails puts it back and throws
      const job = await failedStore.take(id);
      if (!job) return false;
      const queued: Job[] = [];
      try {
        await jobsAdapter.deliver([job], runnerInto(queued));
      } catch (error) {
        await failedStore.fail(job, error);
        throw error;
      }
      await deliver(queued);
      return true;
    },
    async failed(options = {}) {
      const store = jobsAdapter.failed ? jobsAdapter : failedStore;
      if (!store?.failed) throw new Error(`[logic-sdk] ${yours} can't list failed jobs. Use one that keeps them, or jobs.failed (${ADAPTERS}).`);
      const { source, scope, limit = 100, cursor } = options;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error(`[logic-sdk] jobs.failed({ limit }) takes 1 to 1000 (got ${String(limit)}).`);
      const page = await store.failed({ source, scope: scope === undefined ? undefined : scopeMatches(scope), limit, cursor });
      return {
        jobs: page.rows.map(({ id, job, error, failedAt }) => ({
          id,
          kind: job.kind,
          source: infoOf(job).source,
          scope: (job.kind === "call" ? job.scope : job.kind === "delivery" ? job.envelope.scope : undefined) as never, // what `store` saved, typed by the caller
          error,
          failedAt,
          job,
        })),
        cursor: page.cursor,
      };
    },
    async forget(id) {
      const store = jobsAdapter.forget ? jobsAdapter : failedStore;
      if (!store?.forget) throw new Error(`[logic-sdk] ${yours} keeps no failed jobs, so there's nothing to forget (${id}). Use one that keeps them, or jobs.failed (${ADAPTERS}).`);
      return store.forget(id);
    },
    /**
     * One run of a cron, due or not, through the adapter as a tick's would go. Its id is the minute's plus a uuid, so a
     * tick for that minute still runs (stored adapters run each id once), and so does a second invoke.
     */
    async invoke(target, options = {}) {
      const c = typeof target === "string" ? cronById.get(target) : crons.find((r) => r.cron === target);
      if (!c)
        throw new Error(
          typeof target === "string"
            ? `[logic-sdk] jobs.invoke(${JSON.stringify(target)}): no cron has that id (${[...cronById.keys()].join(", ") || "none registered"}).`
            : "[logic-sdk] jobs.invoke got a cron that isn't registered: export it from its module.",
        );
      const { minute, stamp } = minuteOf(options.at ?? now(), "jobs.invoke({ at })");
      const job: CronJob = { kind: "cron", id: `${c.id}@${stamp}-${crypto.randomUUID()}`, cron: c.id, scheduledAt: minute.toISOString(), attempts: c.cron.attempts ?? 1, ...(c.cron.queue ? { queue: c.cron.queue } : {}) };
      await enqueueAlone([job]);
      const queued: Job[] = [];
      await jobsAdapter.deliver([job], runnerInto(queued)); // unlike a tick, a hand-off that fails throws: whoever invoked it needs to know
      await deliver(queued);
      return job.id;
    },
  };

  return { toJobs, deliver, jobs, due, checkHold, checkRetries, checkQueue, yours };
}
