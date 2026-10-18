export type ChinaHolidayCalendar = {
  year: number;
  holidays: ReadonlyArray<string>;
  makeupWorkdays: ReadonlyArray<string>;
};

// Source: State Council General Office, 2026 holiday schedule, 2025-11-04.
// https://www.scio.gov.cn/zdgz/jj/202511/t20251110_938367.html
const CALENDARS: Readonly<Record<number, ChinaHolidayCalendar>> = {
  2026: {
    year: 2026,
    holidays: [
      "2026-01-01", "2026-01-02", "2026-01-03",
      "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
      "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
      "2026-04-04", "2026-04-05", "2026-04-06",
      "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
      "2026-06-19", "2026-06-20", "2026-06-21",
      "2026-09-25", "2026-09-26", "2026-09-27",
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
      "2026-10-06", "2026-10-07",
    ],
    // Makeup workdays are documented for reference only. DeepSeek peak pricing
    // treats every Saturday and Sunday as off-peak, including these dates.
    makeupWorkdays: [
      "2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10",
    ],
  },
};

export class MissingHolidayCalendarError extends Error {
  constructor(year: number) {
    super(`No China holiday calendar is available for ${year}; add that year's official schedule before calculating DeepSeek peak pricing.`);
    this.name = "MissingHolidayCalendarError";
  }
}

export function getChinaHolidayCalendar(year: number): ChinaHolidayCalendar {
  const calendar = CALENDARS[year];
  if (!calendar) throw new MissingHolidayCalendarError(year);
  return {
    year: calendar.year,
    holidays: [...calendar.holidays],
    makeupWorkdays: [...calendar.makeupWorkdays],
  };
}

export function isChinaHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  return getChinaHolidayCalendar(year).holidays.includes(date);
}
