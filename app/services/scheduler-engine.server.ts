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

// Handles both "YYYY-MM-DD" (date) and "YYYY-MM-DDTHH:mm:ssZ" (date_time)
function normalizeDateValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes("T") ? trimmed.split("T")[0] : trimmed;
}

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

export function evaluateCollectionSchedule(input: {
  startDateValue: string | null | undefined;
  endDateValue: string | null | undefined;
  shopTimezone: string;
  now?: Date;
}): ScheduleEvaluation {
  const today = getTodayInTimeZone(input.shopTimezone, input.now);
  const startDate = input.startDateValue ? normalizeDateValue(input.startDateValue) : null;
  const endDate = input.endDateValue ? normalizeDateValue(input.endDateValue) : null;

  if (!startDate) {
    return {
      outcome: "skip",
      reason: "missing_start_date",
      message: "Missing schedule.start_date metafield value.",
      today,
      startDate,
      endDate,
    };
  }

  if (!endDate) {
    return {
      outcome: "skip",
      reason: "missing_end_date",
      message: "Missing schedule.end_date metafield value.",
      today,
      startDate,
      endDate,
    };
  }

  if (!isValidCalendarDate(startDate)) {
    return {
      outcome: "skip",
      reason: "invalid_start_date",
      message: `Invalid schedule.start_date value "${startDate}". Expected YYYY-MM-DD.`,
      today,
      startDate,
      endDate,
    };
  }

  if (!isValidCalendarDate(endDate)) {
    return {
      outcome: "skip",
      reason: "invalid_end_date",
      message: `Invalid schedule.end_date value "${endDate}". Expected YYYY-MM-DD.`,
      today,
      startDate,
      endDate,
    };
  }

  if (endDate < startDate) {
    return {
      outcome: "skip",
      reason: "end_before_start",
      message: `Inconsistent schedule range: end_date "${endDate}" is before start_date "${startDate}".`,
      today,
      startDate,
      endDate,
    };
  }

  const shouldBePublished = today >= startDate && today <= endDate;

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

