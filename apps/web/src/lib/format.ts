export const money = (v: unknown, currency = 'USD') => {
  if (v === null || v === undefined || v === '') return '–';
  const n = Number(v);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
};
export const num = (v: unknown, digits = 2) => (v === null || v === undefined || v === '' ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits }));
export const date = (v: unknown) => (v ? new Date(String(v).length === 10 ? `${v}T00:00:00` : String(v)).toLocaleDateString() : '–');
export const dateTime = (v: unknown) => (v ? new Date(String(v)).toLocaleString() : '–');
export const ago = (v: string) => {
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
export const human = (code: string | null | undefined) => (code ? code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '');
/** The company's business time zone (from the signed-in user's profile); Cambodia by default. */
function companyTimeZone(): string {
  try {
    return JSON.parse(localStorage.getItem('ckh.me') ?? 'null')?.timezone ?? 'Asia/Phnom_Penh';
  } catch {
    return 'Asia/Phnom_Penh';
  }
}
/** Today's business date in the company's time zone (not UTC), 'YYYY-MM-DD'. */
export const today = () => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: companyTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};
export const monthStart = () => `${today().slice(0, 7)}-01`;
