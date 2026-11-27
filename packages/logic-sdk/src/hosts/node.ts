import type { Jobs } from "../core/types.ts";

export interface WorkOptions {
  /** Jobs this process runs at once. Default 1, like pg-boss, graphile-worker and a Laravel worker: run more processes, or raise it. */
  concurrency?: number;
  /** Seconds a free slot waits before it looks for a job again, when there was none. Default 2, like pg-boss and graphile-worker. */
  pollEvery?: number;
  /**
   * The queues it runs, in order: each claim takes the first one with a job due, so `["mail", "default"]` sends mail
   * first. Each one of `jobs.queues`, or `"default"`. Default: every queue, oldest due first.
   */
  queues?: readonly string[];
  /** Where a failed tick or claim goes, and a skipped minute. Default `console.error`. */
  onError?: (error: unknown) => void;
}

export interface StopOptions {
  /** Seconds to wait for the running jobs and ticks before giving up on them. Default 30, like pg-boss's `stop()`. */
  timeout?: number;
}

const MINUTE = 60_000;
/**
 * Ticks still running before the next is skipped (reported). Overlap is normal, like Laravel and Oban: a slow cron
 * doesn't hold back the next minute. Ten still running means they're stuck (the database is unreachable), and letting
 * them pile up would run a backlog of stale minutes when it comes back.
 */
const MAX_RUNNING = 10;
/** The longest a slot waits between claims while they throw (the database is down), so an outage is reported less and less often. */
const MAX_WAIT = 30;

/**
 * A worker, like Laravel's `queue:work` and `schedule:work` in one process: `concurrency` slots, each claiming the next
 * due job (`registry.jobs.sweep({ limit: 1 })`) and waiting `pollEvery` seconds when there's none, and your crons
 * ticked on every minute. Run as many as you like: a job is claimed once, and a cron's minute runs once. A minute the
 * process wasn't running for is skipped, not caught up. In the web process, it takes the jobs requests commit, so they
 * answer at once and it starts them right away; in a process of its own, it claims what's due, `pollEvery` seconds
 * apart when there's nothing (with `databaseQueue({ runIn: "worker" })` that's every job). Returns `stop()`, which
 * waits for the running jobs and ticks, `timeout` seconds at most.
 *
 * ```ts
 * import { work } from "logic-sdk/node";
 * const stop = work(registry, { concurrency: 5 });
 * process.on("SIGTERM", async () => { await stop(); process.exit(0); });
 * ```
 */
export function work(registry: { jobs: Pick<Jobs, "tick" | "sweep" | "attach"> }, options: WorkOptions = {}): (options?: StopOptions) => Promise<void> {
  const { concurrency = 1, pollEvery = 2, queues } = options;
  const reportTo = options.onError ?? ((error) => console.error("[logic-sdk]", error));
  const onError = (error: unknown) => {
    try {
      reportTo(error);
    } catch (inner) {
      console.error("[logic-sdk] onError threw", inner, "while reporting", error); // like the registry's: the loops keep going
    }
  };
  let stopping = false;
  /** The sleeping slots: a commit wakes as many as it has jobs, `stop()` all of them. */
  const wakes = new Set<() => void>();
  const wakeUp = (count = Infinity) => {
    for (const wake of [...wakes].slice(0, count)) wake();
  };
  /** Resolves after `seconds`, or at once on `stop()`. */
  const sleep = (seconds: number) =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        wakes.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, seconds * 1000);
      wakes.add(wake);
    });

  /** One job at a time: the next due one, back to back while there are some. */
  async function slot() {
    let wait = pollEvery;
    while (!stopping) {
      try {
        const { done, failed, discarded, retrying } = await registry.jobs.sweep({ limit: 1, queues });
        wait = pollEvery;
        if (done + failed + discarded + retrying) continue;
      } catch (error) {
        onError(error);
        wait = Math.min(wait * 2, MAX_WAIT);
      }
      await sleep(wait);
    }
  }

  const ticks = new Set<Promise<void>>();
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  const startOfMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
  const tick = (at: Date) => {
    if (ticks.size >= MAX_RUNNING) {
      onError(new Error(`[logic-sdk] skipped the ${at.toISOString()} tick: ${ticks.size} earlier ticks are still running. Is the database reachable?`));
      return;
    }
    const run = registry.jobs.tick(at).then(() => {}, onError);
    ticks.add(run);
    void run.finally(() => ticks.delete(run));
  };
  const armTick = (minute: number) => {
    tickTimer = setTimeout(() => {
      // early by a millisecond: still this minute. Late (the machine slept): the current one, not a backlog
      const due = Math.max(minute, startOfMinute(Date.now()));
      armTick(due + MINUTE); // the next one first, so a slow tick can't delay it
      tick(new Date(due));
    }, minute - Date.now());
  };

  const detach = registry.jobs.attach({ wake: wakeUp, queues }); // first: it throws on a queue jobs.queues doesn't declare
  armTick(startOfMinute(Date.now()) + MINUTE);
  const slots = Array.from({ length: concurrency }, slot);

  return async ({ timeout = 30 } = {}) => {
    stopping = true;
    detach(); // requests run their own jobs again
    clearTimeout(tickTimer);
    wakeUp();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeout * 1000)));
    await Promise.race([Promise.all([...slots, ...ticks]), gaveUp]);
    clearTimeout(timer);
  };
}
