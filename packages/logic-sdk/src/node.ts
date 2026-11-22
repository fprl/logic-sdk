import type { Jobs } from "./index.ts";

export interface TickingOptions {
  /** Seconds between sweeps: databaseQueue's retries, delayed jobs and what a crash left behind. Default 60; 0 turns it off. */
  sweepEvery?: number;
  /** Where a failed tick or sweep goes, and a skipped minute. Default `console.error`. */
  onError?: (error: unknown) => void;
}

export interface StopOptions {
  /** Seconds to wait for the running ticks and sweeps before giving up on them. Default 30, like pg-boss's `stop()`. */
  timeout?: number;
}

const MINUTE = 60_000;
/**
 * Ticks, and sweeps, still running before the next of its kind is skipped (reported). Overlap is normal, like Laravel and
 * Oban: a slow cron doesn't hold back the next minute, and a hung job doesn't stop the sweeps, as it wouldn't stop the
 * other workers of a queue. Ten still running means they're stuck (the database is unreachable), and letting them pile
 * up would run a backlog of stale minutes when it comes back.
 */
const MAX_RUNNING = 10;

/**
 * A long-running process's cron trigger, like Laravel's `schedule:work`: ticks your crons on every minute and sweeps
 * every `sweepEvery` seconds, neither waiting for the last, so a slow cron or a hung job doesn't hold back the rest. A
 * minute the process wasn't running for is skipped, not caught up (Laravel and pg-boss do the same). Returns `stop()`,
 * which resolves once the running ticks and sweeps finish, or after `timeout` seconds (30) if they're stuck.
 *
 * ```ts
 * import { startTicking } from "logic-sdk/node";
 * const stop = startTicking(registry);
 * process.on("SIGTERM", async () => { await stop(); process.exit(0); }); // waits 30 s at most: stop({ timeout })
 * ```
 */
export function startTicking(
  registry: { jobs: Pick<Jobs, "tick" | "sweep"> },
  options: TickingOptions = {},
): (options?: StopOptions) => Promise<void> {
  const sweepEvery = options.sweepEvery ?? 60;
  const reportTo = options.onError ?? ((error) => console.error("[logic-sdk]", error));
  const onError = (error: unknown) => {
    try {
      reportTo(error);
    } catch (inner) {
      console.error("[logic-sdk] onError threw", inner, "while reporting", error); // like the registry's: the loops keep going
    }
  };
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  const ticks = new Set<Promise<void>>();
  const sweeps = new Set<Promise<void>>();

  const startOfMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;

  const track = (running: Set<Promise<void>>, work: Promise<unknown>) => {
    const run = work.then(() => {}, onError);
    running.add(run);
    void run.finally(() => running.delete(run));
  };

  const tick = (at: Date) => {
    if (ticks.size >= MAX_RUNNING) {
      onError(new Error(`[logic-sdk] skipped the ${at.toISOString()} tick: ${ticks.size} earlier ticks are still running. Is the database reachable?`));
      return;
    }
    track(ticks, registry.jobs.tick(at));
  };

  const armTick = (minute: number) => {
    tickTimer = setTimeout(() => {
      // early by a millisecond: still this minute. Late (the machine slept): the current one, not a backlog
      const due = Math.max(minute, startOfMinute(Date.now()));
      armTick(due + MINUTE); // the next one first, so a slow tick can't delay it
      tick(new Date(due));
    }, minute - Date.now());
  };

  const sweep = () => {
    sweepTimer = setTimeout(sweep, sweepEvery * 1000); // the next one first, so a hung job can't stop the sweeps
    if (sweeps.size >= MAX_RUNNING) {
      onError(new Error(`[logic-sdk] skipped a sweep: ${sweeps.size} earlier sweeps are still running. Is a job hung, or the database unreachable?`));
      return;
    }
    track(sweeps, registry.jobs.sweep());
  };

  armTick(startOfMinute(Date.now()) + MINUTE);
  if (sweepEvery > 0) sweepTimer = setTimeout(sweep, sweepEvery * 1000);

  return async ({ timeout = 30 } = {}) => {
    clearTimeout(tickTimer);
    clearTimeout(sweepTimer);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeout * 1000)));
    await Promise.race([Promise.all([...ticks, ...sweeps]), gaveUp]);
    clearTimeout(timer);
  };
}
