const publicRecordNumberPattern = /^\d{2,3}$/;
const canonicalRecordNumberPattern = /^CM-\d{2,3}$/;
const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): boolean {
  if (!calendarDatePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isPublicRecordNumber(value: string): boolean {
  return publicRecordNumberPattern.test(value);
}

export function normalizeArchiveRecordNumber(value: string): string {
  if (publicRecordNumberPattern.test(value)) return `CM-${value}`;
  if (canonicalRecordNumberPattern.test(value)) return value;
  return value;
}
