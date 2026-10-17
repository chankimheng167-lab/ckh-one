/**
 * Business dates are calendar dates in the tenant's own time zone
 * (tenants.timezone, Asia/Phnom_Penh for Cambodian companies), never UTC:
 * an order taken at 06:30 in Phnom Penh belongs to that local day.
 */
export const DEFAULT_TIMEZONE = 'Asia/Phnom_Penh';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** 'YYYY-MM-DD' for the given instant in the given IANA time zone. */
export function businessDate(timeZone: string = DEFAULT_TIMEZONE, at: Date = new Date()): string {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Calendar year of the instant in the tenant's zone (document number prefixes). */
export function businessYear(timeZone: string = DEFAULT_TIMEZONE, at: Date = new Date()): number {
  return Number(businessDate(timeZone, at).slice(0, 4));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Default zone for a new tenant from its country. */
export function defaultTimeZoneFor(countryCode: string | undefined): string {
  switch ((countryCode ?? 'KH').toUpperCase()) {
    case 'TH':
      return 'Asia/Bangkok';
    case 'VN':
      return 'Asia/Ho_Chi_Minh';
    case 'LA':
      return 'Asia/Vientiane';
    case 'CN':
      return 'Asia/Shanghai';
    case 'SG':
      return 'Asia/Singapore';
    default:
      return DEFAULT_TIMEZONE;
  }
}
