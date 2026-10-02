const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../RORC App/app.js"), "utf8");
const context = {RORCRecurringDates: require("../scripts/rorc-recurring-dates")};
vm.runInNewContext(source.slice(source.indexOf("function parseRecurringExclusions("), source.indexOf("function calendarRecurringOptions(")), context);
const build = (options) => Array.from(context.buildRecurringDateSeries({seedDate: "2026-10-01", selectedDays: [2, 4], every: 1, unit: "week", endMode: "on", endDate: "2026-10-15", ...options}));
test("weekday series previews exact dates and inclusive exclusions", () => {
  assert.deepEqual(build({exclusions: "2026-10-06\n2026-10-08 to 2026-10-13"}), ["2026-10-01", "2026-10-15"]);
});
test("school request cannot silently infer abbreviated exclusions or start time", () => {
  assert.throws(() => build({exclusions: "Nov23 &25"}), /Invalid exclusion/);
  assert.throws(() => build({seedDate: ""}), /valid start date/);
});
test("counts apply after exclusion and fortnightly schedule is deterministic across DST", () => {
  assert.deepEqual(build({seedDate: "2026-10-27", every: 2, endMode: "after", occurrences: 4, exclusions: "2026-10-29"}), ["2026-10-27", "2026-11-10", "2026-11-12", "2026-11-24"]);
});
test("monthly dates stay anchored at month end", () => {
  assert.deepEqual(build({seedDate: "2027-01-31", unit: "month", endMode: "after", occurrences: 3}), ["2027-01-31", "2027-02-28", "2027-03-31"]);
});
test("invalid and oversized schedules are rejected instead of truncated", () => {
  assert.throws(() => build({seedDate: "2026-02-30"}), /valid start/);
  assert.throws(() => build({endDate: "2026-09-01"}), /End date/);
  assert.throws(() => build({endMode: "never"}), /end date/);
  assert.throws(() => build({unit: "day", endDate: "2027-10-01"}), /240/);
  assert.throws(() => build({selectedDays: []}), /recurring day/);
});

const availabilityContext = { fetch: async () => ({ok: true, json: async () => ({success: true, dates: [], blocks: [{date: "2026-10-01", start: "10:00", end: "11:00"}]})}), collectCalendarRentalPayload: () => ({event_start_time: "09:00", event_end_time: "10:30"}), normalizeTimeFieldValue: (v) => v };
vm.runInNewContext(source.slice(source.indexOf("async function preflightRecurringRentals("), source.indexOf("function uidSeriesToken(")), availabilityContext);
const root = {querySelector: () => ({value: "09:00", checked: false})};
test("preflight rejects overlap and fails closed if availability is unavailable", async () => {
  await assert.rejects(availabilityContext.preflightRecurringRentals(root, ["2026-10-01"]), /Conflicting rental access/);
  availabilityContext.fetch = async () => ({ok: false, json: async () => ({})});
  await assert.rejects(availabilityContext.preflightRecurringRentals(root, ["2026-10-01"]), /No recurring bookings were saved/);
});
