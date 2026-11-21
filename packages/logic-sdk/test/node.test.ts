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
  stop();
});

test("a slow tick or sweep never skips a minute", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const { registry, ticked, sweeps } = fake({ tickTakes: 5 * 60_000, sweepTakes: 5 * 60_000 });
  const stop = startTicking(registry, { sweepEvery: 10 });
  jest.advanceTimersByTime(4 * 60_000);
  expect(ticked).toEqual(["09:01", "09:02", "09:03", "09:04"]);
  expect(sweeps()).toBe(1); // one at a time: the first is still running
  stop();
});

test("after the machine slept, it ticks the current minute, not a backlog", () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:30Z") });
  const { registry, ticked } = fake();
  const stop = startTicking(registry, { sweepEvery: 0 });
  jest.setSystemTime(new Date("2026-11-23T14:00:10Z")); // the laptop was closed for five hours
  jest.advanceTimersByTime(60_000);
  expect(ticked).toEqual(["14:00", "14:01"]);
  stop();
});

test("stop() stops both loops", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const { registry, ticked, sweeps } = fake();
  const stop = startTicking(registry, { sweepEvery: 30 });
  await stop();
  jest.advanceTimersByTime(5 * 60_000);
  expect([ticked, sweeps()]).toEqual([[], 0]);
});

test("stop() resolves once the running tick and sweep finish, for a graceful shutdown", async () => {
  const tick = Promise.withResolvers<void>();
  const sweep = Promise.withResolvers<void>();
  const finished: string[] = [];
  const registry = {
    jobs: {
      tick: () => tick.promise.then(() => void finished.push("tick")).then(() => []),
      sweep: () => sweep.promise.then(() => void finished.push("sweep")).then(() => ({ done: 0, failed: 0, discarded: 0, retrying: 0 })),
    },
  };
  jest.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z") });
  const stop = startTicking(registry, { sweepEvery: 60 });
  jest.advanceTimersByTime(60_000); // both start
  let stopped = false;
  const stopping = stop().then(() => void (stopped = true));
  await Promise.resolve();
  expect(stopped).toBe(false);
  tick.resolve();
  sweep.resolve();
  await stopping;
  expect(finished.sort()).toEqual(["sweep", "tick"]);
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
