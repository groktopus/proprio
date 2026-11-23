/** Shared cron interpretation for routine schedule previews and execution. */

interface RoutineCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
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
    if (!part) throw new Error(`Empty element in cron ${spec.name} field`);
    const match = /^(\*|([0-9]+)(?:-([0-9]+))?)(?:\/([0-9]+))?$/.exec(part);
    if (!match) throw new Error(`Invalid element "${part}" in cron ${spec.name} field`);
    const [, base, startText, endText, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) throw new Error(`Invalid step "${stepText}" in cron ${spec.name} field`);
    const start = base === "*" ? spec.min : Number(startText);
    const end = endText !== undefined ? Number(endText) : base === "*" || stepText !== undefined ? spec.max : start;
    for (const value of [start, end]) {
      if (value < spec.min || value > spec.max) {
        throw new Error(`Value ${value} out of range [${spec.min}–${spec.max}] for cron ${spec.name} field`);
      }
    }
    if (start > end) throw new Error(`Invalid range ${start}-${end} in cron ${spec.name} field (start > end)`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

function coversField(values: number[], spec: typeof SPECS[number]) {
  return values.length === spec.max - spec.min + 1 && values[0] === spec.min && values.at(-1) === spec.max;
}

export function parseRoutineCron(expression: string): RoutineCron {
  const trimmed = expression.trim();
  if (!trimmed) throw new Error("Cron expression must not be empty");
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, got ${fields.length}: "${trimmed}"`);
  }
  return {
    minutes: parseField(fields[0]!, SPECS[0]),
    hours: parseField(fields[1]!, SPECS[1]),
    daysOfMonth: parseField(fields[2]!, SPECS[2]),
    months: parseField(fields[3]!, SPECS[3]),
    daysOfWeek: parseField(fields[4]!, SPECS[4]),
  };
}

function formatter(timeZone: string) {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      weekday: "short", hourCycle: "h23",
    });
    formatterCache.set(timeZone, value);
  }
  return value;
}

export function assertRoutineTimeZone(timeZone: string) {
  formatter(timeZone);
}

export function nextRoutineCronFire(expression: string | RoutineCron, timeZone: string, after: Date): Date | null {
  const cron = typeof expression === "string" ? parseRoutineCron(expression) : expression;
  const format = timeZone === "UTC" ? null : formatter(timeZone);
  if (!Number.isFinite(after.getTime())) throw new RangeError("Invalid reference date");

  const eitherDayMatches = !coversField(cron.daysOfMonth, SPECS[2]) && !coversField(cron.daysOfWeek, SPECS[4]);
  function matchesDay(day: number, weekday: number) {
    const dayOfMonthMatches = cron.daysOfMonth.includes(day);
    const dayOfWeekMatches = cron.daysOfWeek.includes(weekday);
    return eitherDayMatches ? dayOfMonthMatches || dayOfWeekMatches : dayOfMonthMatches && dayOfWeekMatches;
  }

  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const deadline = cursor.getTime() + 5 * 366 * 24 * 60 * 60_000;
  while (cursor.getTime() < deadline) {
    if (!format) {
      if (!cron.months.includes(cursor.getUTCMonth() + 1) || !matchesDay(cursor.getUTCDate(), cursor.getUTCDay())) {
        cursor.setUTCHours(24, 0, 0, 0);
        continue;
      }
      if (cron.hours.includes(cursor.getUTCHours()) && cron.minutes.includes(cursor.getUTCMinutes())) return cursor;
    } else {
      const parts: Record<string, string> = {};
      for (const part of format.formatToParts(cursor)) {
        if (part.type !== "literal") parts[part.type] = part.value;
      }
      const weekday = WEEKDAYS[parts.weekday ?? ""];
      if (weekday === undefined) throw new Error(`Unable to resolve weekday for ${timeZone}`);
      if (
        cron.minutes.includes(Number(parts.minute)) && cron.hours.includes(Number(parts.hour))
        && cron.months.includes(Number(parts.month)) && matchesDay(Number(parts.day), weekday)
      ) return cursor;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
