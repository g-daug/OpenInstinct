import { z } from "zod";

export const FOLLOW_UP_RECURRENCES = [
  "once",
  "daily",
  "weekly",
  "weekdays",
] as const;

export const followUpRecurrenceSchema = z.enum(FOLLOW_UP_RECURRENCES);
export type FollowUpRecurrence = z.infer<typeof followUpRecurrenceSchema>;

interface LocalDateTime {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly second: number;
  readonly year: number;
}

export function assertTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid IANA time zone: ${timezone}`);
  }
}

export function nextFollowUpRun({
  after,
  currentRunAt,
  recurrence,
  timezone,
}: {
  readonly after: Date;
  readonly currentRunAt: string;
  readonly recurrence: Exclude<FollowUpRecurrence, "once">;
  readonly timezone: string;
}) {
  assertTimeZone(timezone);
  let local = zonedDateTime(new Date(currentRunAt), timezone);

  for (let attempts = 0; attempts < 370; attempts += 1) {
    local = addLocalDays(local, recurrence === "weekly" ? 7 : 1);
    if (recurrence === "weekdays" && isWeekend(local)) continue;

    const candidate = localDateTimeToInstant(local, timezone);
    if (candidate.getTime() > after.getTime()) return candidate.toISOString();
  }

  throw new Error("Unable to calculate the next follow-up occurrence.");
}

export function nextDailyRunAt({
  after,
  hour,
  minute,
  timezone,
}: {
  readonly after: Date;
  readonly hour: number;
  readonly minute: number;
  readonly timezone: string;
}) {
  assertTimeZone(timezone);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("The local hour must be between 0 and 23.");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("The local minute must be between 0 and 59.");
  }

  const localAfter = zonedDateTime(after, timezone);
  let localCandidate: LocalDateTime = {
    ...localAfter,
    hour,
    minute,
    second: 0,
  };
  let candidate = localDateTimeToInstant(localCandidate, timezone);
  if (candidate.getTime() <= after.getTime()) {
    localCandidate = addLocalDays(localCandidate, 1);
    candidate = localDateTimeToInstant(localCandidate, timezone);
  }

  return candidate.toISOString();
}

function addLocalDays(value: LocalDateTime, days: number): LocalDateTime {
  const date = new Date(
    Date.UTC(
      value.year,
      value.month - 1,
      value.day + days,
      value.hour,
      value.minute,
      value.second
    )
  );
  return {
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    month: date.getUTCMonth() + 1,
    second: date.getUTCSeconds(),
    year: date.getUTCFullYear(),
  };
}

function isWeekend(value: LocalDateTime) {
  const day = new Date(
    Date.UTC(value.year, value.month - 1, value.day)
  ).getUTCDay();
  return day === 0 || day === 6;
}

function localDateTimeToInstant(value: LocalDateTime, timezone: string) {
  const desired = localDateTimeEpoch(value);
  let timestamp = desired;

  for (let attempts = 0; attempts < 4; attempts += 1) {
    const actual = zonedDateTime(new Date(timestamp), timezone);
    const adjustment = desired - localDateTimeEpoch(actual);
    if (adjustment === 0) break;
    timestamp += adjustment;
  }

  return new Date(timestamp);
}

function localDateTimeEpoch(value: LocalDateTime) {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second
  );
}

function zonedDateTime(date: Date, timezone: string): LocalDateTime {
  if (Number.isNaN(date.getTime())) throw new Error("Invalid follow-up time.");
  const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  const { day, hour, minute, month, second, year } = values;
  if (
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    month === undefined ||
    second === undefined ||
    year === undefined
  ) {
    throw new Error("Unable to resolve the follow-up time zone.");
  }
  return { day, hour, minute, month, second, year };
}
