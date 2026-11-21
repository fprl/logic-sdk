import { afterEach, expect, jest, test } from "bun:test";
import { startTicking } from "../src/node.ts";

afterEach(() => jest.useRealTimers());

/** A registry whose tick and sweep record when they ran, and can be made slow. */
function fake(options: { tickTakes?: number; sweepTakes?: number } = {}) {
  const ticked: string[] = [];
  let sweeps = 0;
  const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  const registry = {
    jobs: {
      async tick(at = new Date()) {
        ticked.push(at.toISOString().slice(11, 16));
        await wait(options.tickTakes);
        return [];
      },
      async sweep() {
        sweeps++;
        await wait(options.sweepTakes);
        return { done: 0, failed: 0, discarded: 0, retrying: 0 };
      },
    },
  };
  return { registry, ticked, sweeps: () => sweeps };
}

test("ticks on every minute, on the minute", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:20Z") });
  const { registry, ticked } = fake();
  const stop = startTicking(registry, { sweepEvery: 0 });
  jest.advanceTimersByTime(3 * 60_000);
  expect(ticked).toEqual(["09:01", "09:02", "09:03"]);
  void stop();
});

test("a slow tick or sweep never skips a minute", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const { registry, ticked, sweeps } = fake({ tickTakes: 5 * 60_000, sweepTakes: 5 * 60_000 });
  const stop = startTicking(registry, { sweepEvery: 10 });
  jest.advanceTimersByTime(4 * 60_000);
  expect(ticked).toEqual(["09:01", "09:02", "09:03", "09:04"]);
  expect(sweeps()).toBe(1); // one at a time: the first is still running
  void stop();
});

test("after the machine slept, it ticks the current minute, not a backlog", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:30Z") });
  const { registry, ticked } = fake();
  const stop = startTicking(registry, { sweepEvery: 0 });
  jest.setSystemTime(new Date("2026-11-23T14:00:10Z")); // the laptop was closed for five hours
  jest.advanceTimersByTime(60_000);
  expect(ticked).toEqual(["14:00", "14:01"]);
  void stop();
});

test("stop() stops both loops", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const { registry, ticked, sweeps } = fake();
  const stop = startTicking(registry, { sweepEvery: 30 });
  await stop();
  jest.advanceTimersByTime(5 * 60_000);
  expect([ticked, sweeps()]).toEqual([[], 0]);
});

/** Let every promise that can settle, settle. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A registry whose tick and sweep wait until the test lets them finish. */
function held() {
  const tick = Promise.withResolvers<void>();
  const sweep = Promise.withResolvers<void>();
  const registry = {
    jobs: {
      tick: () => tick.promise.then(() => []),
      sweep: () => sweep.promise.then(() => ({ done: 0, failed: 0, discarded: 0, retrying: 0 })),
    },
  };
  return { registry, tick, sweep };
}

test("stop() resolves once the running tick and sweep finish, for a graceful shutdown", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const { registry, tick, sweep } = held();
  const stop = startTicking(registry, { sweepEvery: 60 });
  jest.advanceTimersByTime(60_000); // both start
  let stopped = false;
  const stopping = stop().then(() => void (stopped = true));
  await flush();
  expect(stopped).toBe(false);
  tick.resolve();
  await flush();
  expect(stopped).toBe(false); // the sweep is still running
  sweep.resolve();
  await stopping;
  expect(stopped).toBe(true);
});

test("stop() gives up on stuck work after its timeout, so a shutdown can't hang", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const { registry } = held(); // never finishes: the database is unreachable
  const stop = startTicking(registry, { sweepEvery: 0 });
  jest.advanceTimersByTime(60_000);
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
  let sweeps = 0;
  const registry = {
    jobs: {
      tick: async () => [],
      sweep: async () => {
        sweeps++;
        throw new Error("db down");
      },
    },
  };
  const quiet = console.error;
  console.error = () => {};
  const stop = startTicking(registry, { sweepEvery: 10, onError: () => { throw new Error("pager down"); } });
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(10_000);
    await flush();
  }
  console.error = quiet;
  expect(sweeps).toBe(3);
  await stop();
});

test("ticks stuck on an unreachable database don't pile up: past ten, a minute is skipped and reported", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const ticked: string[] = [];
  const errors: string[] = [];
  const registry = {
    jobs: {
      tick: (at = new Date()) => {
        ticked.push(at.toISOString().slice(11, 16));
        return new Promise<string[]>(() => {}); // waiting for a connection that never comes
      },
      sweep: async () => ({ done: 0, failed: 0, discarded: 0, retrying: 0 }),
    },
  };
  const stop = startTicking(registry, { sweepEvery: 0, onError: (e) => errors.push((e as Error).message) });
  jest.advanceTimersByTime(12 * 60_000);
  expect(ticked).toHaveLength(10);
  expect(errors).toEqual([
    expect.stringMatching(/skipped the 2026-11-23T09:11:00\.000Z tick: 10 earlier ticks are still running/),
    expect.stringMatching(/09:12/),
  ]);
  void stop();
});
