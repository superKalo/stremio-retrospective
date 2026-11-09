import { minimumReleaseYear } from './config.ts';

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function parseCalendarDate(value: string): { year: number; month: number; day: number } {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match || value.length !== 10) throw new RangeError('Expected a Gregorian date in YYYY-MM-DD format');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysByMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysByMonth[month - 1]) {
    throw new RangeError('Expected a Gregorian date in YYYY-MM-DD format');
  }
  return { year, month, day };
}

export function effectiveUtcDate(now: Date, explicitDate?: string): string {
  const today = now.toISOString().slice(0, 10);
  if (explicitDate === undefined) return today;

  const { year } = parseCalendarDate(explicitDate);
  if (year <= minimumReleaseYear || explicitDate > today) {
    throw new RangeError(`The date must be between ${minimumReleaseYear + 1}-01-01 and today (UTC)`);
  }
  return explicitDate;
}

export function historicalDates(effectiveDate: string): string[] {
  const { year, month, day } = parseCalendarDate(effectiveDate);
  const monthAndDay = effectiveDate.slice(4);
  const dates: string[] = [];
  for (let pastYear = minimumReleaseYear; pastYear < year; pastYear++) {
    if (month === 2 && day === 29 && !isLeapYear(pastYear)) continue;
    dates.push(pastYear + monthAndDay);
  }
  return dates;
}
