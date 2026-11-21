/**
 * Five-field cron expressions (`minute hour day-of-month month day-of-week`), matched against one minute in a time zone.
 * Lists, ranges and steps (`1,15`, `9-17`, `*\/5`, `1-30/5`), month and weekday names, `7` as Sunday. Days follow
 * Vixie cron: when both day fields are restricted, either one matching is enough.
 */
export interface Schedule {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** Restricted day fields (not starting with `*`): both restricted means day OR weekday. */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELDS = {
  minute: { name: "minute", min: 0, max: 59 },
  hour: { name: "hour", min: 0, max: 23 },
  day: { name: "day of month", min: 1, max: 31 },
  month: { name: "month", min: 1, max: 12, names: MONTHS },
  weekday: { name: "day of week", min: 0, max: 7, names: WEEKDAYS },
} satisfies Record<string, Field>;

export function parseSchedule(expression: string): Schedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(`[logic-sdk] cron schedule "${expression}" needs five fields (minute hour day month weekday), like "0 9 * * 1".`);
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = parts;
  const weekdays = parseField(weekday, FIELDS.weekday, expression);
  if (weekdays.delete(7)) weekdays.add(0); // 7 is Sunday too
  return {
    minute: parseField(minute, FIELDS.minute, expression),
    hour: parseField(hour, FIELDS.hour, expression),
    day: parseField(day, FIELDS.day, expression),
    month: parseField(month, FIELDS.month, expression),
    weekday: weekdays,
    dayRestricted: !day.startsWith("*"),
    weekdayRestricted: !weekday.startsWith("*"),
  };
}

/** `names` start at `min`: `jan` is 1, `sun` is 0. */
interface Field {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
}

function parseField(part: string, field: Field, expression: string): Set<number> {
  const fail = () => new Error(`[logic-sdk] cron schedule "${expression}" has an invalid ${field.name}: "${part}".`);
  const value = (token: string) => {
    const index = field.names?.indexOf(token.toLowerCase()) ?? -1;
    const n = index >= 0 ? index + field.min : /^\d+$/.test(token) ? Number(token) : NaN;
    if (!(n >= field.min && n <= field.max)) throw fail();
    return n;
  };
  const values = new Set<number>();
  for (const item of part.split(",")) {
    const [range = "", stepText, extra] = item.split("/");
    if (extra !== undefined || range === "") throw fail();
    if (stepText !== undefined && !/^\d+$/.test(stepText)) throw fail();
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw fail();
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [field.min, field.max];
    else {
      const [a = "", b, more] = range.split("-");
      if (more !== undefined) throw fail();
      // a step needs `*` or a range: `5/15` means different things in different crons
      if (b === undefined && stepText !== undefined) throw fail();
      from = value(a);
      to = b === undefined ? from : value(b);
      if (from > to) throw fail();
    }
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return values;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock in `timeZone`. Throws a RangeError for an unknown zone. */
function wallClock(date: Date, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const { type, value } of format.formatToParts(date)) parts[type] = value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS.indexOf((parts.weekday ?? "").toLowerCase()),
  };
}

/**
 * Is `date`'s minute due in `timeZone`? Wall-clock matching, like Laravel: a time skipped when clocks go forward doesn't
 * run, and one that happens twice when they go back runs twice.
 */
export function isDue(schedule: Schedule, date: Date, timeZone = "UTC"): boolean {
  const t = wallClock(date, timeZone);
  const day = schedule.day.has(t.day);
  const weekday = schedule.weekday.has(t.weekday);
  const dayOk = schedule.dayRestricted && schedule.weekdayRestricted ? day || weekday : day && weekday;
  return dayOk && schedule.minute.has(t.minute) && schedule.hour.has(t.hour) && schedule.month.has(t.month);
}

/** Checks a time zone name, so a typo fails at startup, not on the first tick. */
export function assertTimeZone(timeZone: string): void {
  wallClock(new Date(0), timeZone);
}
