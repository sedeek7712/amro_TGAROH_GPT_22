/**
 * أدوات التاريخ والوقت المحلي الموحدة (Asia/Aden — توقيت اليمن UTC+3)
 * تمنع انزياح التاريخ الناتج عن استخدام UTC في toISOString().split('T')[0]
 */

export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Aden';

/**
 * تنسيق التاريخ بصيغة قياسية YYYY-MM-DD وفق المنطقة الزمنية المحلية للعمل
 */
export function formatLocalDate(
  dateInput: Date | number | string = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE
): string {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return formatLocalDate(new Date(), timeZone);
  }

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);

    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Fallback to device local calendar fields if timeZone is unsupported
  }

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * تنسيق الوقت المحلي للطباعة وترويسة المستندات (HH:MM)
 */
export function formatLocalTime(
  dateInput: Date | number | string = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE
): string {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return formatLocalTime(new Date(), timeZone);
  }

  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}

/**
 * إرجاع طابع الإصدار المحلي الكامل للعرض في المطبوعات
 */
export function formatLocalDateTime(
  dateInput: Date | number | string = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE
): {
  date: string;
  time: string;
  year: number;
  displayTabular: string;
} {
  const date = formatLocalDate(dateInput, timeZone);
  const time = formatLocalTime(dateInput, timeZone);
  const year = Number(date.slice(0, 4)) || new Date().getFullYear();
  return {
    date,
    time,
    year,
    displayTabular: `${date} ${time}`,
  };
}
