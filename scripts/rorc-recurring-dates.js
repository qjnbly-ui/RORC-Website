(function(root) {
"use strict";
function parseRecurringExclusions(value) {
  const ranges = String(value || "").split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
  return ranges.map((entry) => {
    const match = entry.match(/^(\d{4}-\d{2}-\d{2})(?:\s+to\s+(\d{4}-\d{2}-\d{2}))?$/);
    const valid = (date) => date && Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
    if (!match || !valid(match[1]) || (match[2] && !valid(match[2])) || (match[2] && match[2] < match[1])) {
      throw new Error(`Invalid exclusion: ${entry}. Use YYYY-MM-DD or YYYY-MM-DD to YYYY-MM-DD.`);
    }
    return [match[1], match[2] || match[1]];
  });
}

function buildRecurringDateSeries({ seedDate, selectedDays, every = 1, unit = "week", endMode = "after", endDate = "", occurrences = 12, exclusions = "" }) {
  const seed = new Date(`${seedDate}T12:00:00Z`);
  if (!Number.isFinite(seed.getTime()) || seed.toISOString().slice(0, 10) !== seedDate) throw new Error("Choose a valid start date.");
  const interval = Number(every);
  if (!Number.isInteger(interval) || interval < 1 || interval > 24) throw new Error("Repeat interval must be between 1 and 24.");
  if (!["day", "week", "month", "year"].includes(unit)) throw new Error("Choose a repeat unit.");
  if (!["on", "after"].includes(endMode)) throw new Error("Choose an end date or number of occurrences.");
  if (endMode === "on" && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < seedDate || new Date(`${endDate}T12:00:00Z`).toISOString().slice(0, 10) !== endDate)) throw new Error("End date must be valid and on or after the start date.");
  const count = Number(occurrences);
  if (endMode === "after" && (!Number.isInteger(count) || count < 1 || count > 240)) throw new Error("Choose 1–240 occurrences.");
  const days = new Set((selectedDays || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (unit === "week" && !days.size) throw new Error("Select at least one recurring day.");
  const excluded = parseRecurringExclusions(exclusions);
  const dates = [];
  for (let offset = 0; offset <= 366 * 10; offset += 1) {
    const cursor = new Date(seed); cursor.setUTCDate(seed.getUTCDate() + offset);
    const key = cursor.toISOString().slice(0, 10);
    if (endMode === "on" && key > endDate) return dates;
    const months = (cursor.getUTCFullYear() - seed.getUTCFullYear()) * 12 + cursor.getUTCMonth() - seed.getUTCMonth();
    const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
    const match = unit === "day" ? offset % interval === 0
      : unit === "week" ? Math.floor(offset / 7) % interval === 0 && days.has(cursor.getUTCDay())
      : unit === "month" ? months % interval === 0 && cursor.getUTCDate() === Math.min(seed.getUTCDate(), lastDay)
      : (cursor.getUTCFullYear() - seed.getUTCFullYear()) % interval === 0 && cursor.getUTCMonth() === seed.getUTCMonth() && cursor.getUTCDate() === Math.min(seed.getUTCDate(), lastDay);
    if (!match || excluded.some(([start, end]) => key >= start && key <= end)) continue;
    dates.push(key);
    if (dates.length > 240) throw new Error("Schedule exceeds 240 occurrences. Choose a shorter date range.");
    if (endMode === "after" && dates.length === count) return dates;
  }
  throw new Error("Schedule exceeds the 10-year preview range. Choose a shorter date range.");
}


const api = { parseRecurringExclusions, buildRecurringDateSeries };
if (typeof module === "object" && module.exports) module.exports = api;
else root.RORCRecurringDates = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
