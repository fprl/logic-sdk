import { describeIssues, isDomainError, StalePayload } from "./errors.ts";
import { isDue, parseSchedule } from "./schedule.ts";
import type {
  ActionCtx,
  Call,
  CallJob,
  CronJob,
  DatabaseAdapter,
  Delivery,
  Envelope,
  FailureInfo,
  Fn,
  InProcess,
  Job,
  JobOutcome,
  JobsAdapter,
  JobScope,
  Jobs,
  ListenerEvent,
  RegisteredCron,
  RegisteredEvent,
  RegisteredFn,
  RegisteredListener,
  RunJobOptions,
  Runner,
} from "./types.ts";
import { RUNS_NOW } from "./types.ts";

const IN_PROCESS: InProcess = {
  [RUNS_NOW]: true,
  async deliver(jobs, { run }) {
    // one try, whatever `attempts` says: what throws has failed, so onError never hears of a retry that won't come
    for (const job of jobs) await run({ ...job, attempts: 1 });
  },
};
/**
 * Default adapter: runs each job right after commit, in this process, one try (like Laravel's sync queue). It can't
 * hold a job for later, so a `delay` or a waiting `ctx.schedule` is refused. Lost on crash: use `databaseQueue` when that matters.
 */
export const inProcess = (): InProcess => IN_PROCESS;
/** `inProcess()`: runs each job right after commit, in this process, so no scope waits at rest. */
export const runsNow = (adapter: JobsAdapter) => adapter === IN_PROCESS;

/**
 * What makes a scheduled call replaceable, `<function id>@<key>`: a newer call with the same one replaces it while it
 * waits. Undefined for every other job. For adapters that replace (`replaces: true`).
 */
export const replaceKeyOf = (job: Job): string | undefined => (job.kind === "call" && job.replace !== undefined ? `${job.fn}@${job.replace}` : undefined);

/** One listener's share of an event, as a job: `<listener id>@<event id>`, with the listener's tries. */
export const deliveryOf = (l: RegisteredListener, e: Envelope): Delivery => ({
  kind: "delivery",
  id: `${l.id}@${e.id}`,
  listener: l.id,
  envelope: e,
  attempts: l.listener.attempts ?? 1,
});

/** What running jobs needs from the registry: its definitions, and how it runs a function or a listener's handler. */
export interface JobsDeps {
  listeners: readonly RegisteredListener[];
  events: readonly RegisteredEvent[];
  crons: readonly RegisteredCron[];
  functions: readonly RegisteredFn[];
  idOf(x: object): string;
  jobsAdapter: JobsAdapter;
  database: DatabaseAdapter<unknown, unknown> | undefined;
  jobScope: JobScope | undefined;
  maxEventDepth: number;
  now(): Date;
  wrap(call: Call, next: () => Promise<unknown>): Promise<unknown>;
  report(error: unknown, info: FailureInfo): void;
  /** Run a function as `scope`, like `registry.as(scope).run`. `eventDepth`: the chain's hops so far (a scheduled call's `depth`). */
  runAs(fn: Fn, input: unknown, scope: object, eventDepth: number | undefined, queued: Job[] | undefined): Promise<unknown>;
  /** The ctx a listener's handler gets, as `scope`, in an event chain `eventDepth` deep. */
  listenerCtx(scope: object, eventDepth: number, id: string, queued: Job[] | undefined): ActionCtx<any>;
}

/**
 * Jobs, for one registry: a listener's share of an event, a cron's run, a scheduled call. Turns a commit's events and
 * calls into jobs, runs one (with its tries), and is what `registry.jobs` calls.
 */
export function makeJobs(deps: JobsDeps) {
  const { listeners, events, crons, functions, idOf, jobsAdapter, database, jobScope, maxEventDepth, now, wrap, report, runAs, listenerCtx } = deps;
  const keepFailed = jobsAdapter.fail?.bind(jobsAdapter);
  const enqueue = jobsAdapter.enqueue?.bind(jobsAdapter);

  // ── listeners ────────────────────────────────────────────────────────────
  const byEvent = new Map<string, RegisteredListener[]>();
  for (const l of listeners) {
    const name = idOf(l.event);
    byEvent.set(name, [...(byEvent.get(name) ?? []), l]);
  }
  const eventByName = new Map(events.map((e) => [e.id, e.event]));

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
    if (!holds)
      throw new Error(`[logic-sdk] ${what} waits ${seconds}s, but your jobs adapter can't hold jobs (inProcess() can't). Use databaseQueue(database).`);
    if (holds !== true && seconds > holds.max)
      throw new Error(`[logic-sdk] ${what} waits ${seconds}s; your jobs adapter holds jobs for at most ${holds.max}s. Put an outbox in front, outbox(database, queue): it holds them as long as needed.`);
  }
  for (const l of listeners) if (l.listener.delay) checkHold(l.id, l.listener.delay);

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
    const fits = (job: { depth: number }) => job.depth <= maxEventDepth;
    const deepEvent = envelopes.find((e) => !fits(e));
    const deepCall = calls.find((c) => !fits(c));
    const loop = (what: string) => new Error(`[logic-sdk] chain of events and calls deeper than ${maxEventDepth} (maxEventDepth): stopped queueing ${what} (a loop?)`);
    if (deepEvent) report(loop(deepEvent.name), { source: deepEvent.name });
    else if (deepCall) report(loop(deepCall.fn), infoOf(deepCall));
    const deliveries = envelopes.filter(fits).flatMap((e) =>
      (byEvent.get(e.name) ?? []).filter((l) => wants(l, e, parsed.get(e))).map((l): Delivery => {
        const job = deliveryOf(l, e);
        const delay = l.listener.delay;
        if (delay) job.runAt = new Date(Date.parse(e.occurredAt) + delay * 1000).toISOString();
        return job;
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
    const loaded = await jobScope.load(stored);
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
    const failed = async (error: unknown) => {
      report(error, { ...info, outcome: "failed" });
      await fail?.(error);
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
        const retrying = attempt < attempts && !(error instanceof StalePayload) && !(isDomainError(error) && error.kind !== "conflict");
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
      return attemptOnce(async () => {
        await runAs(c.cron.run, c.cron.input, c.cron.scope, undefined, queued);
        return "done";
      });
    }
    if (job.kind === "call") {
      const f = fnById.get(job.fn);
      if (!f) return missing("function", job.fn);
      return attemptOnce(async () => {
        const scope = await scopeOf(job, job.scope, attempt);
        if (!scope) return "discarded";
        await runAs(f.fn, job.input, scope, job.depth, queued);
        return "done";
      });
    }
    if (job.kind !== "delivery") return cantRun(`job ${id} has kind ${JSON.stringify(kind)}, which this version can't run.`);
    const l = listenerById.get(job.listener);
    if (!l) return missing("listener", job.listener);
    const { envelope } = job;
    const event = eventByName.get(envelope.name);
    return attemptOnce(async () => {
      const scope = await scopeOf(job, envelope.scope, attempt);
      if (!scope) return "discarded";
      await wrap({ id: l.id, kind: "listener", meta: l.listener.meta, input: envelope.payload, scope, depth: 0 }, async () => {
        let payload = envelope.payload;
        if (event) {
          const r = await event.payload["~standard"].validate(payload);
          if (r.issues) throw new StalePayload(`[logic-sdk] ${envelope.name} payload no longer matches its schema: ${JSON.stringify(describeIssues(r.issues))}`);
          payload = r.value;
        }
        const ctxEvent: ListenerEvent = { id: envelope.id, name: envelope.name, payload, occurredAt: envelope.occurredAt, attempt };
        return l.listener.handler({ ...listenerCtx(scope, envelope.depth, l.id, queued), event: ctxEvent } as never, payload); // SAFETY: as in index.ts's invoke: the ctx was built for a listener
      });
      return "done";
    });
  }

  /** A runner whose jobs' own jobs are collected in `queued`. */
  const runnerInto = (queued: Job[]): Runner => ({
    run: (job, options) => runJob(job, options, queued),
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

  /** The runs due in `at`'s minute: one job per cron, with an id per minute, so a tick that's delivered twice runs once. */
  function due(at: Date): CronJob[] {
    if (Number.isNaN(at.getTime())) throw new Error(`[logic-sdk] tick needs a valid date (got ${String(at)}).`);
    const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
    const stamp = minute.toISOString().slice(0, 16).replaceAll(/[-:]/g, "") + "Z"; // 20261123T0900Z: no `:`, which BullMQ rejects
    return scheduled
      .filter((c) => isDue(c.schedule, minute, c.cron.timezone))
      .map((c) => ({ kind: "cron", id: `${c.id}@${stamp}`, cron: c.id, scheduledAt: minute.toISOString(), attempts: c.cron.attempts ?? 1 }));
  }

  const jobs: Jobs = {
    // a consumer's own `fail` (pg-boss's work(), which records the reason itself) wins over the adapter's
    run: (job, options) => runJob(job, { ...options, fail: options?.fail ?? (keepFailed && ((error) => keepFailed(job, error))) }),
    async tick(at = now()) {
      const jobs = due(at);
      if (!jobs.length) return [];
      if (enqueue) {
        if (!database) throw new Error("[logic-sdk] Crons through a jobs adapter that stores them (like databaseQueue(database)) need `database`.");
        await database.transaction((tx) => enqueue(tx, jobs));
      }
      await deliver(jobs);
      return jobs.map((job) => job.cron);
    },
    async sweep(options) {
      const queued: Job[] = [];
      const result = (await jobsAdapter.sweep?.(runnerInto(queued), options)) ?? { done: 0, failed: 0, discarded: 0, retrying: 0 };
      await deliver(queued);
      return result;
    },
    async retry(id) {
      if (!jobsAdapter.retry) throw new Error(`[logic-sdk] your jobs adapter keeps no jobs, so there's nothing to retry (${id}). databaseQueue(database), outbox(database, queue) and pgBoss(boss) do.`);
      return jobsAdapter.retry(id);
    },
  };

  return { toJobs, deliver, jobs, due, checkHold };
}
