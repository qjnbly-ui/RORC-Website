import { createHash } from 'node:crypto';

export type Closure = { id: string; starts_on: string; reopens_on: string; reason: string; status: string };
export type Line = {
  id: string; amount: number; currency: string; period: { start: number; end: number };
  discount_amounts?: Array<{ amount: number }> | null;
  price?: { id: string } | null; pricing?: { price_details?: { price: string | { id: string } } | null } | null;
  type?: string; proration?: boolean;
  parent?: { subscription_item_details?: { proration?: boolean } | null } | null;
};
export type Detail = { invoice: string; line: string; plan: string; periodStart: string; periodEnd: string; chargedCents: number; closedDays: number; periodDays: number; creditCents: number };
export type Preview = { amount: number; details: Detail[]; warnings: string[]; fingerprint: string };
const DAY = 86400000;
export function dayNumber(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Enter a valid date.');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('Enter a valid date.');
  return time / DAY;
}
export function facilityDate(seconds = Date.now() / 1000): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(seconds * 1000));
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function validateDates(start: string, end: string): void {
  const days = dayNumber(end) - dayNumber(start);
  if (days <= 0) throw new Error('Reopening must be after the first closed day.');
  if (days > 366) throw new Error('Review closures longer than one year separately.');
  if (end > facilityDate()) throw new Error('Apply closure credits after the gym has reopened.');
}
export function priceId(line: Line): string {
  const price = line.pricing?.price_details?.price || line.price?.id;
  return typeof price === 'string' ? price : price?.id || '';
}
export function overlaps(line: Line, closure: Closure): boolean {
  if (!line.period?.start || !line.period?.end) return false;
  return facilityDate(line.period.start) < closure.reopens_on && facilityDate(line.period.end) > closure.starts_on;
}
export function calculateLine(line: Line, invoice: string, plan: string, closure: Closure): Detail | null {
  if (!overlaps(line, closure)) return null;
  if (line.currency !== 'usd') throw new Error('Non-USD membership requires manual review.');
  if (line.proration || line.parent?.subscription_item_details?.proration || line.amount < 0) throw new Error('Membership plan changes or prorations require manual review.');
  const periodStart = facilityDate(line.period.start);
  const periodEnd = facilityDate(line.period.end);
  const periodDays = dayNumber(periodEnd) - dayNumber(periodStart);
  if (periodDays < 27 || periodDays > 32) throw new Error('Non-monthly membership period requires manual review.');
  const chargedCents = Math.max(0, line.amount - (line.discount_amounts || []).reduce((sum, d) => sum + d.amount, 0));
  if (!Number.isSafeInteger(chargedCents)) throw new Error('Invalid membership charge.');
  const closedDays = Math.max(0, Math.min(dayNumber(periodEnd), dayNumber(closure.reopens_on)) - Math.max(dayNumber(periodStart), dayNumber(closure.starts_on)));
  return { invoice, line: line.id, plan, periodStart, periodEnd, chargedCents, closedDays, periodDays, creditCents: Math.round(chargedCents * closedDays / periodDays) };
}
export function finishPreview(details: Detail[], warnings: string[]): Preview {
  details.sort((a, b) => a.line.localeCompare(b.line));
  const uniqueWarnings = [...new Set(warnings)].sort();
  const amount = details.reduce((sum, d) => sum + d.creditCents, 0);
  return { amount, details, warnings: uniqueWarnings, fingerprint: createHash('sha256').update(JSON.stringify({ details, warnings: uniqueWarnings })).digest('hex') };
}
