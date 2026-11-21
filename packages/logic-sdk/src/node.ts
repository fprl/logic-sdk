import type { Jobs } from "./index.ts";

export interface TickingOptions {
  /** Seconds between sweeps: the outbox's retries, delayed jobs and what a crash left behind. Default 60; 0 turns it off. */
  sweepEvery?: number;
  /** Where a failed tick or sweep goes, and a skipped minute. Default `console.error`. */
  onError?: (error: unknown) => void;
}

export interface StopOptions {
  /** Seconds to wait for the running ticks and sweep before giving up on them. Default 30, like pg-boss's `stop()`. */
  timeout?: number;
}

const MINUTE = 60_000;
/**
 * Ticks still running before the next minute is skipped (reported). Overlap is normal, like Laravel and Oban: a slow
 * cron doesn't hold back the next minute. Ten still running means they're stuck (the database is unreachable), and
 * letting them pile up would run a backlog of stale minutes when it comes back.
 */
const MAX_RUNNING_TICKS = 10;

/**
 * A long-running process's cron trigger, like Laravel's `schedule:work`: ticks your crons on every minute and sweeps on
 * its own loop, so a slow cron or sweep doesn't hold back the next minute. A minute the process wasn't running for is
 * skipped, not caught up (Laravel and pg-boss do the same). Returns `stop()`, which resolves once the running ticks and
 * sweep finish, or after `timeout` seconds (30) if they're stuck.
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
  let stopped = false;
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  const ticks = new Set<Promise<void>>();
  let sweeping: Promise<void> | undefined;

  const startOfMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;

  const tick = (at: Date) => {
    if (ticks.size >= MAX_RUNNING_TICKS) {
      onError(new Error(`[logic-sdk] skipped the ${at.toISOString()} tick: ${ticks.size} earlier ticks are still running. Is the database reachable?`));
      return;
    }
    const running = registry.jobs.tick(at).then(() => {}, onError);
    ticks.add(running);
    void running.finally(() => ticks.delete(running));
  };

  const armTick = (minute: number) => {
    tickTimer = setTimeout(() => {
      // early by a millisecond: still this minute. Late (the machine slept): the current one, not a backlog
      const due = Math.max(minute, startOfMinute(Date.now()));
      armTick(due + MINUTE); // the next one first, so a slow tick can't delay it
      tick(new Date(due));
    }, minute - Date.now());
  };

  const sweep = async () => {
    sweeping = registry.jobs.sweep().then(() => {}, onError);
    await sweeping;
    if (!stopped) sweepTimer = setTimeout(sweep, sweepEvery * 1000);
  };

  armTick(startOfMinute(Date.now()) + MINUTE);
  if (sweepEvery > 0) sweepTimer = setTimeout(sweep, sweepEvery * 1000);

  return async ({ timeout = 30 } = {}) => {
    stopped = true;
    clearTimeout(tickTimer);
    clearTimeout(sweepTimer);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeout * 1000)));
    await Promise.race([Promise.all([...ticks, sweeping]), gaveUp]);
    clearTimeout(timer);
  };
}
