import { describeIssues, isDomainError, StalePayload } from "./errors.ts";
import { isDue, parseSchedule } from "./schedule.ts";
import type {
  ActionCtx,
  Call,
  CronJob,
  DatabaseAdapter,
  Delivery,
  DeliveryOutcome,
  Dispatcher,
  Envelope,
  FailureInfo,
  Fn,
  Job,
  JobScope,
  Jobs,
  ListenerEvent,
  RegisteredCron,
  RegisteredEvent,
  RegisteredListener,
  RunJobOptions,
  Runner,
} from "./types.ts";

/**
 * Default dispatcher: delivers right after commit, in this process, once, ignoring `attempts` and `delay` (like Laravel's
 * sync queue). Lost on crash: use an outbox when that matters.
 */
export const inProcess = (): Dispatcher => ({
  async deliver(deliveries, { run }) {
    for (const d of deliveries) await run(d).catch(() => {}); // already reported; nothing retries in-process
  },
});

/** What running jobs needs from the registry: its definitions, and how it runs a function or a listener's handler. */
export interface JobsDeps {
  listeners: readonly RegisteredListener[];
  events: readonly RegisteredEvent[];
  crons: readonly RegisteredCron[];
  idOf(x: object): string;
  dispatcher: Dispatcher;
  database: DatabaseAdapter<unknown, unknown> | undefined;
  jobScope: JobScope | undefined;
  maxEventDepth: number;
  now(): Date;
  wrap(call: Call, next: () => Promise<unknown>): Promise<unknown>;
  report(error: unknown, info: FailureInfo): void;
  /** Run a function as `scope`, like `registry.as(scope).run`. */
  runAs(fn: Fn, input: unknown, scope: object): Promise<unknown>;
  /** The ctx a listener's handler gets, as `scope`, in an event chain `eventDepth` deep. */
  listenerCtx(scope: object, eventDepth: number, id: string): ActionCtx<any>;
}

/**
 * Jobs, for one registry: a listener's share of an event, a cron's run. Turns events into jobs, runs one (with its
 * tries), and is what `registry.jobs` calls.
 */
export function makeJobs(deps: JobsDeps) {
  const { listeners, events, crons, idOf, dispatcher, database, jobScope, maxEventDepth, now, wrap, report, runAs, listenerCtx } = deps;
  const keepFailed = dispatcher.fail?.bind(dispatcher);
  const enqueue = dispatcher.enqueue?.bind(dispatcher);

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

  /** What `onError` hears about a job. */
  const infoOf = (job: Job, attempt?: number): FailureInfo =>
    job.kind === "cron"
      ? { listener: job.cron, envelope: undefined, delivery: job.id, attempt }
      : { listener: job.listener, envelope: job.envelope, delivery: job.id, attempt };

  /**
   * Run one job: a listener's share of an event, or a cron's run. Reports every failure; throws only when a retry might
   * help and there are tries left. `fail` keeps a job that failed for good.
   */
  async function runJob(job: Job, { attempt = 1, fail }: RunJobOptions = {}): Promise<DeliveryOutcome> {
    const info = infoOf(job, attempt);
    const kind: string = job.kind; // a job queued by another version can have a kind this one doesn't know
    const failed = async (error: unknown) => {
      report(error, { ...info, outcome: "failed" });
      await fail?.(error);
      return "failed" as const;
    };
    /** One try, with the tries read from the code (like Rails' retry_on: a deploy that changes them applies to queued jobs). */
    const attemptOnce = async (attempts: number, work: () => Promise<DeliveryOutcome>): Promise<DeliveryOutcome> => {
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

    // code this version doesn't have (renamed or removed): failed at once and kept, like Rails' ClassMissingError.
    // `registry.jobs.retry(id)` runs it once the code is back.
    if (job.kind === "cron") {
      const c = cronById.get(job.cron);
      if (!c) return failed(new Error(`[logic-sdk] ${job.cron} isn't a registered cron (renamed or removed?), so job ${job.id} can't run.`));
      return attemptOnce(c.cron.attempts ?? 1, async () => {
        await runAs(c.cron.run, c.cron.input, c.cron.scope);
        return "done";
      });
    }
    if (job.kind !== "delivery") return failed(new Error(`[logic-sdk] job ${info.delivery} has kind ${JSON.stringify(kind)}, which this version can't run.`));
    const l = listenerById.get(job.listener);
    if (!l) return failed(new Error(`[logic-sdk] ${job.listener} isn't a registered listener (renamed or removed?), so job ${job.id} can't run.`));
    const { envelope } = job;
    const event = eventByName.get(envelope.name);
    return attemptOnce(l.listener.attempts ?? 1, async () => {
      let scope = envelope.scope;
      if (jobScope?.load) {
        const loaded = await jobScope.load(scope);
        if (loaded === undefined) throw new Error(`[logic-sdk] jobs.scope.load returned undefined for ${job.id}. Return the scope, or null to discard the job.`);
        if (loaded === null) {
          report(new Error(`[logic-sdk] jobs.scope.load returned null for ${job.id}, so it was discarded.`), { ...info, outcome: "discarded" });
          return "discarded";
        }
        scope = loaded;
      }
      await wrap({ id: l.id, kind: "listener", meta: l.listener.meta, input: envelope.payload, scope, depth: 0 }, async () => {
        let payload = envelope.payload;
        if (event) {
          const r = await event.payload["~standard"].validate(payload);
          if (r.issues) throw new StalePayload(`[logic-sdk] ${envelope.name} payload no longer matches its schema: ${JSON.stringify(describeIssues(r.issues))}`);
          payload = r.value;
        }
        const ctxEvent: ListenerEvent = { id: envelope.id, name: envelope.name, payload, occurredAt: envelope.occurredAt, attempt };
        return l.listener.handler({ ...listenerCtx(scope, envelope.depth, l.id), event: ctxEvent } as never, payload); // SAFETY: as in invoke
      });
      return "done";
    });
  }

  const runner: Runner = {
    run: runJob,
    report: (e, job, attempt) => report(e, infoOf(job, attempt)),
  };

  // ── crons ────────────────────────────────────────────────────────────────
  const scheduled = crons.map((c) => ({ ...c, schedule: parseSchedule(c.cron.schedule) }));
  const cronById = new Map(crons.map((c) => [c.id, c]));

  /** The runs due in `at`'s minute: one job per cron, with an id per minute, so a tick that's delivered twice runs once. */
  function due(at: Date): CronJob[] {
    if (Number.isNaN(at.getTime())) throw new Error(`[logic-sdk] tick needs a valid date (got ${String(at)}).`);
    const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
    const stamp = minute.toISOString().slice(0, 16).replaceAll(/[-:]/g, "") + "Z"; // 20261123T0900Z: no `:`, which BullMQ rejects
    return scheduled
      .filter((c) => isDue(c.schedule, minute, c.cron.timezone))
      .map((c) => ({ kind: "cron", id: `${c.id}@${stamp}`, cron: c.id, scheduledAt: minute.toISOString() }));
  }

  const jobs: Jobs = {
    run: (job, options) => runJob(job, { ...options, fail: keepFailed && ((error) => keepFailed(job, error)) }),
    async tick(at = now()) {
      const jobs = due(at);
      if (!jobs.length) return [];
      if (enqueue) {
        if (!database) throw new Error("[logic-sdk] Crons through a jobs adapter that stores them (like outbox(db)) need `database`.");
        await database.transaction((tx) => enqueue(tx, jobs));
      }
      await dispatcher.deliver(jobs, runner).catch((e) => report(e, { listener: "(dispatcher)", envelope: undefined }));
      return jobs.map((job) => job.cron);
    },
    sweep: async (options) => (await dispatcher.sweep?.(runner, options)) ?? { done: 0, failed: 0, discarded: 0, retrying: 0 },
    async retry(id) {
      if (!dispatcher.retry) throw new Error(`[logic-sdk] your jobs transport stores no jobs, so there's nothing to retry (${id}). outbox(db) does.`);
      return dispatcher.retry(id);
    },
  };

  return { toDeliveries, runner, jobs, due };
}
