import type { FormField } from "./contracts";

const { normalizePhone } = require("../../api/_rorc-sms") as { normalizePhone: (value: unknown) => string };
const { toSpeechText } = require("../../api/_receptionist") as { toSpeechText: (value: unknown) => string };

export function isYes(value: unknown): boolean {
  return /^(yes|yeah|yep|sure|okay|ok|please|go ahead|connect me|transfer me|sounds good)[.!? ]*$/i.test(String(value || "").trim());
}
export function isGuidedFormChoice(value: unknown): boolean { return /\b(help|guide|walk me through|fill|fill it out|do it with me|ask me)\b/i.test(String(value || "")); }
export function isDirectFormChoice(value: unknown): boolean { return /\b(send|text|link|just the form|do it myself|fill it online)\b/i.test(String(value || "")); }
function isSkip(value: unknown): boolean { return /^(skip|pass|later|i(?:'| a)m not sure|i don'?t know)[.!? ]*$/i.test(String(value || "").trim()); }
export function isFinishForm(value: unknown): boolean { return /\b(send (?:me )?(?:the |my )?link|finish online|i(?:'| a)m done|that(?:'s| is) enough|stop asking)\b/i.test(String(value || "")); }

function formChoiceValue(field: FormField, spoken: string): string {
  const text = spoken.toLowerCase();
  for (const [value, aliases] of Object.entries(field.options || {})) if (aliases.some((alias) => text.includes(alias))) return value;
  return "";
}
export function spokenEmail(value: unknown): string {
  return String(value || "").toLowerCase().replace(/\s+(?:at sign|at)\s+/g, "@").replace(/\s+(?:dot|period)\s+/g, ".").replace(/\s+underscore\s+/g, "_").replace(/\s+(?:dash|hyphen)\s+/g, "-").replace(/\s+/g, "").replace(/[.,;:!?]+$/, "");
}
function isoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function spokenDate(value: unknown, now = new Date()): string {
  const text = String(value || "").toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (/\btoday\b/.test(text)) return today.toISOString().slice(0, 10);
  if (/\btomorrow\b/.test(text)) return new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  const numeric = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const named = text.match(new RegExp(`\\b(${Object.keys(months).join("|")})\\s+(\\d{1,2})(?:,?\\s+(\\d{2,4}))?\\b`));
  let month: number | undefined; let day: number | undefined; let year: number | undefined;
  if (numeric) { month = Number(numeric[1]); day = Number(numeric[2]); year = numeric[3] ? Number(numeric[3]) : today.getUTCFullYear(); }
  else if (named) { month = months[named[1] || ""]; day = Number(named[2]); year = named[3] ? Number(named[3]) : today.getUTCFullYear(); }
  if (month === undefined || day === undefined || year === undefined) return "";
  if (year < 100) year += 2000;
  let result = isoDate(year, month, day);
  if (result && !numeric?.[3] && !named?.[3] && result < today.toISOString().slice(0, 10)) result = isoDate(year + 1, month, day);
  return result;
}
export function spokenNumber(value: unknown): number {
  const digit = String(value || "").match(/\b\d+\b/);
  if (digit) return Number(digit[0]);
  const units: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  let total = 0; let found = false;
  for (const word of String(value || "").toLowerCase().replace(/-/g, " ").split(/\s+/)) {
    if (units[word]) { total += units[word]; found = true; } else if (tens[word]) { total += tens[word]; found = true; } else if (word === "hundred" && total) { total *= 100; found = true; }
  }
  return found ? total : 0;
}
export function spokenTime(value: unknown): string {
  const text = String(value || "").toLowerCase().replace(/\b([ap])\s*\.?\s*m\.?\b/g, "$1m");
  if (/\bnoon\b/.test(text)) return "12:00";
  if (/\bmidnight\b/.test(text)) return "00:00";
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const period = match?.[3] || text.match(/\b(am|pm)\b/)?.[1] || "";
  const clockWords = text.replace(/\b(am|pm)\b/g, "").trim().split(/\s+/);
  let hour = match ? Number(match[1]) : spokenNumber(clockWords[0]);
  const minute = match ? Number(match[2] || 0) : spokenNumber(clockWords.slice(1).join(" "));
  if (!hour || minute > 59 || hour > (period ? 12 : 23) || hour < 0) return "";
  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
export function spokenPhone(value: unknown): string {
  const direct = normalizePhone(value); if (direct) return direct;
  const digits: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  return normalizePhone(String(value || "").toLowerCase().split(/\s+/).map((word) => digits[word.replace(/[^a-z]/g, "")] || word).join(""));
}
export async function normalizeFormAnswer(field: FormField, spoken: string, callerPhone: string): Promise<{ skipped: boolean; value: string | number } | null> {
  const text = spoken.trim();
  if (isSkip(text)) return { skipped: true, value: "" };
  if (field.callerPhoneAllowed && isYes(text)) { const caller = normalizePhone(callerPhone); return caller ? { skipped: false, value: caller } : null; }
  if (field.type === "choice") { const value = formChoiceValue(field, text); return value ? { skipped: false, value } : null; }
  if (field.type === "yesno" || field.type === "yesno-title") {
    if (/\b(yes|yeah|yep|will|do|private)\b/i.test(text)) return { skipped: false, value: field.type === "yesno-title" ? "Yes" : "yes" };
    if (/\b(no|nope|not|won'?t|do not|public)\b/i.test(text)) return { skipped: false, value: field.type === "yesno-title" ? "No" : "no" };
    return null;
  }
  if (field.type === "phone") { const value = spokenPhone(text); return value ? { skipped: false, value } : null; }
  if (field.type === "email") { const value = spokenEmail(text); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? { skipped: false, value } : null; }
  if (field.type === "date") { const value = spokenDate(text); return value ? { skipped: false, value } : null; }
  if (field.type === "time") { const value = spokenTime(text); return value ? { skipped: false, value } : null; }
  if (field.type === "number") { const value = spokenNumber(text); return value > 0 ? { skipped: false, value } : null; }
  const value = toSpeechText(text).slice(0, 500); return value ? { skipped: false, value } : null;
}
