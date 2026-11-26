import type { InProcess, JobsAdapter } from "./types.ts";
import { RUNS_NOW } from "./types.ts";

const IN_PROCESS: InProcess = {
  [RUNS_NOW]: true,
  name: "inProcess()",
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
export const runsNow = (adapter: JobsAdapter) => RUNS_NOW in adapter;
