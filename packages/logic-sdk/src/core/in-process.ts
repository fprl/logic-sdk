import type { InProcess, JobsAdapter } from "./types.ts";
import { RUNS_NOW } from "./types.ts";

/** The last job of each key, in this process: the next one starts after it. */
const lastOfKey = new Map<string, Promise<unknown>>();

const IN_PROCESS: InProcess = {
  [RUNS_NOW]: true,
  name: "inProcess()",
  orders: true,
  queues: true, // nothing waits, so there's nothing to keep apart
  async deliver(jobs, { run }) {
    for (const job of jobs) {
      // one try, whatever `attempts` says: what throws has failed, so onError never hears of a retry that won't come
      const once = () => run({ ...job, attempts: 1 });
      const key = job.kind === "delivery" ? job.key : undefined;
      if (!key) {
        await once();
        continue;
      }
      const mine = (lastOfKey.get(key) ?? Promise.resolve()).then(once);
      const settled = mine.catch(() => {});
      lastOfKey.set(key, settled);
      try {
        await mine;
      } finally {
        if (lastOfKey.get(key) === settled) lastOfKey.delete(key);
      }
    }
  },
};
/**
 * Default adapter: runs each job right after commit, in this process, one try (like Laravel's sync queue). It can't
 * hold a job for later, so a `delay` or a waiting `ctx.schedule` is refused. Lost on crash: use `databaseQueue` when that matters.
 */
export const inProcess = (): InProcess => IN_PROCESS;
/** `inProcess()`: runs each job right after commit, in this process, so no scope waits at rest. */
export const runsNow = (adapter: JobsAdapter) => RUNS_NOW in adapter;
