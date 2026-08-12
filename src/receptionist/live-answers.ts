import type { IntentResult, LiveSnapshot } from "./contracts";

const { toSpeechText } = require("../../api/_receptionist") as { toSpeechText: (value: unknown) => string };

function facilityActivity(snapshot: LiveSnapshot) {
  return snapshot.facility?.data?.activity || null;
}

function spokenWeekday(value: unknown): string {
  return ({ Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday" } as Record<string, string>)[String(value || "")] || String(value || "");
}

function hasLiveNumber(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

export function deterministicLiveAnswer(route: Partial<IntentResult>, snapshot: LiveSnapshot): string {
  const activity = facilityActivity(snapshot);
  if (!activity) return "";
  const stale = snapshot.facility?.freshness === "stale";
  const latest = stale ? "latest recorded" : "latest";
  const fact = String(route.live_fact || "none");
  if (fact === "temperature" && hasLiveNumber(activity.roomTemperatureF)) {
    return `The ${latest} gym temperature is ${Math.round(Number(activity.roomTemperatureF))} degrees Fahrenheit.`;
  }
  if (fact === "humidity" && hasLiveNumber(activity.roomHumidity)) {
    return `The ${latest} gym humidity reading is ${Math.round(Number(activity.roomHumidity))} percent.`;
  }
  if (fact === "occupancy" && hasLiveNumber(activity.occupancyCount)) {
    const count = Number(activity.occupancyCount);
    if (stale) return count === 0 ? "The latest recorded gym occupancy showed no one signed in." : `The latest recorded gym occupancy showed ${count} ${count === 1 ? "person" : "people"} signed in.`;
    return count === 0 ? "No one is currently signed in at the gym." : `${count} ${count === 1 ? "person is" : "people are"} currently signed in at the gym.`;
  }
  if (["activity_trends", "busiest_time", "quietest_time"].includes(fact) && activity.weeklyTrends) {
    const trends = activity.weeklyTrends;
    if (fact === "activity_trends" && trends.busiest?.day && trends.busiest.hour && trends.quietest?.day && trends.quietest.hour) {
      return `Based on check-ins over the past ${Number(trends.weeksAnalyzed || 8)} weeks, the busiest recorded period is ${spokenWeekday(trends.busiest.day)} at ${trends.busiest.hour}, and the quietest is ${spokenWeekday(trends.quietest.day)} at ${trends.quietest.hour}.`;
    }
    const point = fact === "quietest_time" ? trends.quietest : trends.busiest;
    const label = fact === "quietest_time" ? "quietest" : "busiest";
    if (point?.day && point.hour) return `Based on check-ins over the past ${Number(trends.weeksAnalyzed || 8)} weeks, the gym's ${label} recorded period is ${spokenWeekday(point.day)} at ${point.hour}.`;
  }
  if (fact === "checkins") {
    const periods: Array<[unknown, string]> = [
      [activity.checkinsToday, "today"],
      [activity.checkinsThisWeek, "this week"],
      [activity.checkinsThisMonth, "this month"],
    ];
    const available = periods.filter(([value]) => hasLiveNumber(value));
    if (available.length) return `RORC has recorded ${available.map(([value, label]) => `${Number(value)} check-ins ${label}`).join(", ")}.`;
  }
  if (fact === "member_counts" && hasLiveNumber(activity.activeMembers)) {
    return `RORC ${stale ? "most recently listed" : "currently lists"} ${Number(activity.activeMembers)} active members across ${Number(activity.activeMemberAccounts || 0)} active member accounts.`;
  }
  return "";
}

function nextEventFallback(snapshot: LiveSnapshot): string {
  const events = snapshot.events?.data?.events;
  if (!Array.isArray(events)) return "";
  const now = Date.now();
  const next = events.filter((event) => Date.parse(event.endAt || event.startAt || "") >= now)
    .sort((a, b) => Date.parse(a.startAt || "") - Date.parse(b.startAt || ""))[0];
  if (!next?.title || !next.startAt) return "";
  const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", dateStyle: "full", timeStyle: "short" }).format(new Date(next.startAt));
  return `The next listed RORC event is ${toSpeechText(next.title)} on ${when}.`;
}

export function usefulProviderFallback(route: Partial<IntentResult>, snapshot: LiveSnapshot, siteContext: string): string {
  const direct = deterministicLiveAnswer(route, snapshot);
  if (direct) return direct;
  if (["events", "both"].includes(route.live_data || "none")) {
    const event = nextEventFallback(snapshot);
    if (event) return event;
  }
  const activity = facilityActivity(snapshot);
  if (activity && hasLiveNumber(activity.roomTemperatureF)) {
    const count = hasLiveNumber(activity.occupancyCount) ? Number(activity.occupancyCount) : null;
    const stale = snapshot.facility?.freshness === "stale";
    return `The latest${stale ? " recorded" : ""} RORC facility reading is ${Math.round(Number(activity.roomTemperatureF))} degrees Fahrenheit${count === null ? "" : stale ? `, and showed ${count} ${count === 1 ? "person" : "people"} signed in` : `, with ${count} ${count === 1 ? "person" : "people"} currently signed in`}.`;
  }
  const page = siteContext.match(/^Page ([^(]+) \([^)]+\):\s*([^.!?]+[.!?]?)/);
  return page ? `The most relevant RORC information is on the ${toSpeechText(page[1])} page. ${toSpeechText(page[2])}` : "Please visit Ruth Obenchain R C dot com for the current RORC information.";
}
