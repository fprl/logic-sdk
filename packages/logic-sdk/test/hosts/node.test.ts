import { afterEach, expect, jest, test } from "bun:test";
import { work } from "../../src/node.ts";

afterEach(() => jest.useRealTimers());

const none = { done: 0, failed: 0, discarded: 0, retrying: 0 };
const one = { ...none, done: 1 };

/** Let every promise that can settle, settle. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A registry whose ticks record their minute and can be slow, with `jobs` waiting jobs, one per claim. */
function fake(options: { tickTakes?: number; jobs?: number } = {}) {
  const ticked: string[] = [];
  let jobs = options.jobs ?? 0;
  let claims = 0;
  const registry = {
    jobs: {
      attach: () => () => {},
      async tick(at = new Date()) {
        ticked.push(at.toISOString().slice(11, 16));
        await new Promise((resolve) => setTimeout(resolve, options.tickTakes ?? 0));
        return [];
      },
      async sweep() {
        claims++;
        return jobs-- > 0 ? one : none;
      },
    },
  };
  return { registry, ticked, claims: () => claims };
}

test("ticks on every minute, on the minute", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:20Z") });
  const { registry, ticked } = fake();
  const stop = work(registry);
  jest.advanceTimersByTime(3 * 60_000);
  expect(ticked).toEqual(["09:01", "09:02", "09:03"]);
  void stop();
});

test("a slow tick never holds back the next", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const { registry, ticked } = fake({ tickTakes: 5 * 60_000 });
  const stop = work(registry);
  jest.advanceTimersByTime(4 * 60_000);
  expect(ticked).toEqual(["09:01", "09:02", "09:03", "09:04"]);
  void stop();
});

test("after the machine slept, it ticks the current minute, not a backlog", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:30Z") });
  const { registry, ticked } = fake();
  const stop = work(registry);
  jest.setSystemTime(new Date("2026-11-23T14:00:10Z")); // the laptop was closed for five hours
  jest.advanceTimersByTime(60_000);
  expect(ticked).toEqual(["14:00", "14:01"]);
  void stop();
});

test("each slot claims back to back while there are jobs, then waits pollEvery before looking again", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const { registry, claims } = fake({ jobs: 5 });
  const stop = work(registry, { concurrency: 2, pollEvery: 2 });
  await flush();
  expect(claims()).toBe(7); // five jobs, then each of the two slots found none
  jest.advanceTimersByTime(1_999);
  await flush();
  expect(claims()).toBe(7);
  jest.advanceTimersByTime(1);
  await flush();
  expect(claims()).toBe(9);
  await stop();
});

test("while claims throw (the database is down), each is reported and the slot waits twice as long, up to 30 s", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const at: number[] = [];
  const errors: unknown[] = [];
  const registry = {
    jobs: {
      attach: () => () => {},
      tick: async () => [],
      sweep: async () => {
        at.push(Date.now());
        throw new Error("db down");
      },
    },
  };
  const stop = work(registry, { pollEvery: 2, onError: (e) => errors.push(e) });
  for (let i = 0; i < 6; i++) {
    await flush();
    jest.advanceTimersByTime(30_000);
  }
  await flush();
  const waits = at.slice(1).map((t, i) => (t - at[i]!) / 1000);
  expect(waits.slice(0, 5)).toEqual([4, 8, 16, 30, 30]);
  expect(errors).toHaveLength(at.length);
  await stop();
});

test("stop() takes no new jobs, and resolves once the running ones finish", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const running = Promise.withResolvers<void>();
  let claims = 0;
  const registry = {
    jobs: {
      attach: () => () => {},
      tick: async () => [],
      sweep: async () => {
        claims++;
        await running.promise;
        return one;
      },
    },
  };
  const stop = work(registry, { concurrency: 2 });
  await flush();
  let stopped = false;
  const stopping = stop().then(() => void (stopped = true));
  await flush();
  expect(stopped).toBe(false);
  running.resolve();
  await stopping;
  expect([stopped, claims]).toEqual([true, 2]);
});

test("stop() gives up on stuck work after its timeout, so a shutdown can't hang", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const registry = { jobs: { attach: () => () => {}, tick: async () => [], sweep: () => new Promise<typeof none>(() => {}) } }; // a job that never returns
  const stop = work(registry);
  let stopped = false;
  const stopping = stop({ timeout: 5 }).then(() => void (stopped = true));
  jest.advanceTimersByTime(4_999);
  await flush();
  expect(stopped).toBe(false);
  jest.advanceTimersByTime(1);
  await stopping;
  expect(stopped).toBe(true);
});

test("an onError that throws doesn't stop the loops", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  let claims = 0;
  const registry = {
    jobs: {
      attach: () => () => {},
      tick: async () => [],
      sweep: async () => {
        claims++;
        throw new Error("db down");
      },
    },
  };
  const quiet = console.error;
  console.error = () => {};
  const stop = work(registry, { pollEvery: 1, onError: () => { throw new Error("pager down"); } });
  for (let i = 0; i < 3; i++) {
    await flush();
    jest.advanceTimersByTime(30_000);
  }
  console.error = quiet;
  expect(claims).toBeGreaterThanOrEqual(3);
  await stop();
});

test("ticks stuck on an unreachable database don't pile up: past ten, a minute is skipped and reported", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const ticked: string[] = [];
  const errors: string[] = [];
  const registry = {
    jobs: {
      attach: () => () => {},
      tick: (at = new Date()) => {
        ticked.push(at.toISOString().slice(11, 16));
        return new Promise<string[]>(() => {}); // waiting for a connection that never comes
      },
      sweep: async () => none,
    },
  };
  const stop = work(registry, { onError: (e) => errors.push((e as Error).message) });
  jest.advanceTimersByTime(12 * 60_000);
  expect(ticked).toHaveLength(10);
  expect(errors).toEqual([
    expect.stringMatching(/skipped the 2026-11-23T09:11:00\.000Z tick: 10 earlier ticks are still running/),
    expect.stringMatching(/09:12/),
  ]);
  void stop({ timeout: 0 });
});
