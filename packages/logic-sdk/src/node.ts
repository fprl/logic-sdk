import type { Jobs } from "./index.ts";

export interface TickingOptions {
  /** Seconds between sweeps: the outbox's retries, delayed jobs and what a crash left behind. Default 60; 0 turns it off. */
  sweepEvery?: number;
  /** Where a failed tick or sweep goes. Default `console.error`. */
  onError?: (error: unknown) => void;
}

const MINUTE = 60_000;

/**
 * A long-running process's cron trigger, like Laravel's `schedule:work`: ticks your crons on every minute and sweeps on
 * its own loop, so a slow cron or sweep never skips a minute. A minute the process wasn't running for is skipped, not
 * caught up (Laravel and pg-boss do the same). Returns `stop()`.
 *
 * ```ts
 * import { startTicking } from "logic-sdk/node";
 * const stop = startTicking(registry);
 * ```
 */
export function startTicking(registry: { jobs: Pick<Jobs, "tick" | "sweep"> }, options: TickingOptions = {}): () => void {
  const sweepEvery = options.sweepEvery ?? 60;
  const onError = options.onError ?? ((error) => console.error("[logic-sdk]", error));
  let stopped = false;
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;

  const startOfMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;

  const armTick = (minute: number) => {
    tickTimer = setTimeout(() => {
      // early by a millisecond: still this minute. Late (the machine slept): the current one, not a backlog
      const due = Math.max(minute, startOfMinute(Date.now()));
      armTick(due + MINUTE); // the next one first, so a slow tick can't delay it
      registry.jobs.tick(new Date(due)).catch(onError);
    }, minute - Date.now());
  };

  const sweep = async () => {
    await registry.jobs.sweep().catch(onError);
    if (!stopped) sweepTimer = setTimeout(sweep, sweepEvery * 1000);
  };

  armTick(startOfMinute(Date.now()) + MINUTE);
  if (sweepEvery > 0) sweepTimer = setTimeout(sweep, sweepEvery * 1000);

  return () => {
    stopped = true;
    clearTimeout(tickTimer);
    clearTimeout(sweepTimer);
  };
}
