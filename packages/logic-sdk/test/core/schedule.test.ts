import { Cron } from "croner";
import { expect, test } from "bun:test";
import { isDue, parseSchedule } from "../../src/core/schedule.ts";

const expressions = [
  "* * * * *",
  "*/5 * * * *",
  "0 * * * *",
  "0 9 * * *",
  "0 9 * * 1",
  "0 18 * * 5",
  "30 2 * * *",
  "15,45 9-17 * * 1-5",
  "1-30/5 * * * *",
  "0 0 1 * *",
  "0 0 31 * *",
  "0 12 29 2 *",
  "0 0 * * 0",
  "0 0 * * 7",
  "0 0 * * SUN",
  "0 8 * * mon-fri",
  "0 0 1 JAN *",
  "0 6 * jun-aug sat,sun",
  "0 0 13 * 5", // both day fields restricted: the 13th OR any Friday
  "0 0 1,15 * 1",
  "0 0 * 2 *",
  "59 23 31 12 *",
  "*/7 */3 */2 * *",
];

/** Every minute of these spans: a whole week, a month end, and leap day 2028. */
const spans = [
  ["2026-11-16T00:00:00Z", 7 * 24 * 60],
  ["2026-12-30T12:00:00Z", 2 * 24 * 60],
  ["2028-02-28T00:00:00Z", 3 * 24 * 60],
] as const;

for (const timeZone of ["UTC", "Asia/Kolkata"]) {
  test(`matches croner, minute by minute (${timeZone}; no DST here, so the semantics agree)`, () => {
    for (const expression of expressions) {
      const schedule = parseSchedule(expression);
      const oracle = new Cron(expression, { timezone: timeZone });
      for (const [start, minutes] of spans) {
        for (let i = 0; i < minutes; i++) {
          const at = new Date(Date.parse(start) + i * 60_000);
          if (isDue(schedule, at, timeZone) !== oracle.match(at)) throw new Error(`${expression} in ${timeZone} disagrees at ${at.toISOString()}`);
        }
      }
    }
  });
}

test("time zones: the wall clock there, including across DST changes", () => {
  const nineMadrid = parseSchedule("0 9 * * *");
  expect(isDue(nineMadrid, new Date("2026-07-01T07:00:00Z"), "Europe/Madrid")).toBe(true); // summer, UTC+2
  expect(isDue(nineMadrid, new Date("2026-12-01T08:00:00Z"), "Europe/Madrid")).toBe(true); // winter, UTC+1
  expect(isDue(nineMadrid, new Date("2026-12-01T09:00:00Z"), "Europe/Madrid")).toBe(false);

  // like Laravel: 2:30 doesn't exist the night clocks go forward, and happens twice when they go back
  const twoThirty = parseSchedule("30 2 * * *");
  const minutesOf = (day: string) =>
    Array.from({ length: 24 * 60 }, (_, i) => new Date(Date.parse(day) + i * 60_000)).filter((at) => isDue(twoThirty, at, "Europe/Madrid"));
  expect(minutesOf("2026-03-28T22:00:00Z")).toHaveLength(0); // 29 March: 2:00 → 3:00
  expect(minutesOf("2026-10-24T22:00:00Z").map((at) => at.toISOString())).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
});

test("a schedule it can't read fails at once, saying what's wrong", () => {
  expect(() => parseSchedule("@daily")).toThrow(/needs five fields \(minute hour day month weekday\), like "0 9 \* \* 1"/);
  expect(() => parseSchedule("0 0 9 * * 1")).toThrow(/needs five fields/);
  expect(() => parseSchedule("60 * * * *")).toThrow(/invalid minute: "60"/);
  expect(() => parseSchedule("0 9 * * 1L")).toThrow(/invalid day of week: "1L"/);
  expect(() => parseSchedule("0 9 32 * *")).toThrow(/invalid day of month: "32"/);
  expect(() => parseSchedule("*/0 * * * *")).toThrow(/invalid minute/);
  expect(() => parseSchedule("*/1e1 * * * *")).toThrow(/invalid minute/);
  expect(() => parseSchedule("5/15 * * * *")).toThrow(/invalid minute: "5\/15"/); // ambiguous across crons: write */15 or 5-59/15
  expect(() => parseSchedule("0 17-9 * * *")).toThrow(/invalid hour: "17-9"/);
});
