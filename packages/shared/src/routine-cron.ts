/** Shared cron interpretation for routine schedule previews and execution. */

export interface RoutineCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  daysOfMonthWildcard: boolean;
  daysOfWeekWildcard: boolean;
}

const SPECS = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day of week" },
] as const;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function parseField(token: string, spec: typeof SPECS[number]): number[] {
  const values = new Set<number>();
  for (const part of token.split(",")) {
    const match = /^(\*|([0-9]+)(?:-([0-9]+))?)(?:\/([0-9]+))?$/.exec(part);
    if (!match) throw new Error(`Invalid element "${part}" in cron ${spec.name} field`);
    const [, base, startText, endText, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) throw new Error(`Invalid step in cron ${spec.name} field`);
    const start = base === "*" ? spec.min : Number(startText);
    const end = endText !== undefined ? Number(endText) : base === "*" || stepText !== undefined ? spec.max : start;
    if (start < spec.min || start > spec.max || end < spec.min || end > spec.max || start > end) {
      throw new Error(`Invalid range in cron ${spec.name} field`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (!values.size) throw new Error("Empty cron field");
  return [...values].sort((a, b) => a - b);
}

function coversField(values: number[], spec: typeof SPECS[number]) {
  return values.length === spec.max - spec.min + 1 && values[0] === spec.min && values.at(-1) === spec.max;
}

export function parseRoutineCron(expression: string): RoutineCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression must have exactly 5 fields, got ${fields.length}`);
  const daysOfMonth = parseField(fields[2]!, SPECS[2]);
  const daysOfWeek = parseField(fields[4]!, SPECS[4]);
  return {
    minutes: parseField(fields[0]!, SPECS[0]),
    hours: parseField(fields[1]!, SPECS[1]),
    daysOfMonth,
    months: parseField(fields[3]!, SPECS[3]),
    daysOfWeek,
    daysOfMonthWildcard: coversField(daysOfMonth, SPECS[2]),
    daysOfWeekWildcard: coversField(daysOfWeek, SPECS[4]),
  };
}

function formatter(timeZone: string) {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      weekday: "short", hourCycle: "h23",
    });
    formatterCache.set(timeZone, value);
  }
  return value;
}

export function assertRoutineTimeZone(timeZone: string) {
  formatter(timeZone);
}

function matches(cron: RoutineCron, date: Date, timeZone: string) {
  // Cheap UTC filters keep sparse UTC schedules off the Intl formatting path.
  if (timeZone === "UTC" && (
    !cron.minutes.includes(date.getUTCMinutes()) || !cron.hours.includes(date.getUTCHours()) ||
    !cron.months.includes(date.getUTCMonth() + 1)
  )) return false;
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const weekday = WEEKDAYS[parts.weekday ?? ""];
  if (weekday === undefined) throw new Error(`Unable to resolve weekday for ${timeZone}`);
  const domMatches = cron.daysOfMonth.includes(Number(parts.day));
  const dowMatches = cron.daysOfWeek.includes(weekday);
  const dayMatches = !cron.daysOfMonthWildcard && !cron.daysOfWeekWildcard
    ? domMatches || dowMatches
    : domMatches && dowMatches;
  return cron.minutes.includes(Number(parts.minute)) && cron.hours.includes(Number(parts.hour)) &&
    cron.months.includes(Number(parts.month)) && dayMatches;
}

export function nextRoutineCronFire(expression: string, timeZone: string, after: Date): Date | null {
  const cron = parseRoutineCron(expression);
  // Constructing the formatter validates the timezone before searching.
  assertRoutineTimeZone(timeZone);
  if (!Number.isFinite(after.getTime())) throw new RangeError("Invalid reference date");
  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const maxIterations = 366 * 24 * 60 * 5;
  for (let i = 0; i < maxIterations; i++) {
    if (matches(cron, cursor, timeZone)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

