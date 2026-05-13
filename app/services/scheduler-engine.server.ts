export type ScheduleEvaluation =
  | {
      outcome: "ready";
      shouldBePublished: boolean;
      desiredStateLabel: "PUBLISHED" | "UNPUBLISHED";
      reason: "within_window" | "outside_window";
      today: string;
      startDate: string;
      endDate: string;
    }
  | {
      outcome: "skip";
      reason:
        | "missing_start_date"
        | "missing_end_date"
        | "invalid_start_date"
        | "invalid_end_date"
        | "end_before_start";
      message: string;
      today: string;
      startDate: string | null;
      endDate: string | null;
    };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type ParsedScheduleValue =
  | { kind: "date"; raw: string; normalized: string }
  | { kind: "instant"; raw: string; normalized: string; instantMs: number };

function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const [yearString, monthString, dayString] = value.split("-");
  const year = Number(yearString);
  const month = Number(monthString);
  const day = Number(dayString);

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function getTodayInTimeZone(ianaTimezone: string, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive a calendar day for timezone ${ianaTimezone}.`);
  }

  return `${year}-${month}-${day}`;
}

function getTimeZoneOffsetMinutes(timeZone: string, date: Date): number {
  const offsetValue = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")
    ?.value;

  if (!offsetValue) {
    throw new Error(`Unable to derive a timezone offset for ${timeZone}.`);
  }

  if (offsetValue === "GMT" || offsetValue === "UTC") {
    return 0;
  }

  const match = offsetValue.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);

  if (!match) {
    throw new Error(`Unsupported timezone offset "${offsetValue}" for ${timeZone}.`);
  }

  const [, sign, hoursText, minutesText] = match;
  const hours = Number(hoursText);
  const minutes = Number(minutesText ?? "0");
  const absoluteMinutes = hours * 60 + minutes;

  return sign === "-" ? -absoluteMinutes : absoluteMinutes;
}

function zonedDateTimeToInstantMs(input: {
  timeZone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond?: number;
}): number {
  const utcGuess = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second,
    input.millisecond ?? 0,
  );

  let resolved = utcGuess;

  for (let index = 0; index < 3; index += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(input.timeZone, new Date(resolved));
    const nextResolved = utcGuess - offsetMinutes * 60_000;

    if (nextResolved === resolved) {
      break;
    }

    resolved = nextResolved;
  }

  return resolved;
}

function getDayBoundaryInstantMs(
  value: string,
  timeZone: string,
  boundary: "start" | "end",
): number {
  const [yearText, monthText, dayText] = value.split("-");

  return zonedDateTimeToInstantMs({
    timeZone,
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: boundary === "start" ? 0 : 23,
    minute: boundary === "start" ? 0 : 59,
    second: boundary === "start" ? 0 : 59,
    millisecond: boundary === "start" ? 0 : 999,
  });
}

function parseScheduleValue(value: string): ParsedScheduleValue | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (DATE_PATTERN.test(trimmed)) {
    return {
      kind: "date",
      raw: trimmed,
      normalized: trimmed,
    };
  }

  const instantMs = Date.parse(trimmed);

  if (!Number.isFinite(instantMs)) {
    return null;
  }

  return {
    kind: "instant",
    raw: trimmed,
    normalized: new Date(instantMs).toISOString(),
    instantMs,
  };
}

export function evaluateCollectionSchedule(input: {
  startDateValue: string | null | undefined;
  endDateValue: string | null | undefined;
  shopTimezone: string;
  now?: Date;
}): ScheduleEvaluation {
  const today = getTodayInTimeZone(input.shopTimezone, input.now);
  const startDate = input.startDateValue?.trim() || null;
  const endDate = input.endDateValue?.trim() || null;

  if (!startDate) {
    return {
      outcome: "skip",
      reason: "missing_start_date",
      message: "Missing start date metafield value.",
      today,
      startDate,
      endDate,
    };
  }

  if (!endDate) {
    return {
      outcome: "skip",
      reason: "missing_end_date",
      message: "Missing end date metafield value.",
      today,
      startDate,
      endDate,
    };
  }

  const parsedStart = parseScheduleValue(startDate);

  if (!parsedStart || (parsedStart.kind === "date" && !isValidCalendarDate(parsedStart.normalized))) {
    return {
      outcome: "skip",
      reason: "invalid_start_date",
      message: `Invalid schedule.start_date value "${startDate}". Expected YYYY-MM-DD or ISO 8601 date_time.`,
      today,
      startDate,
      endDate,
    };
  }

  const parsedEnd = parseScheduleValue(endDate);

  if (!parsedEnd || (parsedEnd.kind === "date" && !isValidCalendarDate(parsedEnd.normalized))) {
    return {
      outcome: "skip",
      reason: "invalid_end_date",
      message: `Invalid schedule.end_date value "${endDate}". Expected YYYY-MM-DD or ISO 8601 date_time.`,
      today,
      startDate,
      endDate,
    };
  }

  const startInstantMs =
    parsedStart.kind === "date"
      ? getDayBoundaryInstantMs(parsedStart.normalized, input.shopTimezone, "start")
      : parsedStart.instantMs;
  const endInstantMs =
    parsedEnd.kind === "date"
      ? getDayBoundaryInstantMs(parsedEnd.normalized, input.shopTimezone, "end")
      : parsedEnd.instantMs;

  if (endInstantMs < startInstantMs) {
    return {
      outcome: "skip",
      reason: "end_before_start",
      message: `Inconsistent schedule range: end_date "${endDate}" is before start_date "${startDate}".`,
      today,
      startDate,
      endDate,
    };
  }

  const currentInstantMs = (input.now ?? new Date()).getTime();
  const shouldBePublished = currentInstantMs >= startInstantMs && currentInstantMs <= endInstantMs;

  return {
    outcome: "ready",
    shouldBePublished,
    desiredStateLabel: shouldBePublished ? "PUBLISHED" : "UNPUBLISHED",
    reason: shouldBePublished ? "within_window" : "outside_window",
    today,
    startDate,
    endDate,
  };
}
