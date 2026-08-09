const { executeHeaterOff } = require("./heater-off-sequence");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const FACILITY_TIME_ZONE = "America/Los_Angeles";

function authorized(req) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  const authorization = String(req.headers?.authorization || req.headers?.Authorization || "");
  return Boolean(secret && authorization === `Bearer ${secret}`);
}

function zonedParts(value, timeZone = FACILITY_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type) => Number(parts.find((item) => item.type === type)?.value || NaN);
  const result = {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute")
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function parseTimerStop(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function addCalendarDay(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function dateTimeKey(parts) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

function timerSchedule(entry, timeZone = FACILITY_TIME_ZONE) {
  const start = zonedParts(entry?.start_at, timeZone);
  const stop = parseTimerStop(entry?.timer_stop);
  if (!start || !stop) return null;

  const startMinutes = (start.hour * 60) + start.minute;
  const stopMinutes = (stop.hour * 60) + stop.minute;
  const targetDate = stopMinutes < startMinutes ? addCalendarDay(start) : start;
  const durationMinutes = stopMinutes >= startMinutes
    ? stopMinutes - startMinutes
    : (24 * 60) - startMinutes + stopMinutes;

  return {
    key: dateTimeKey({ ...targetDate, hour: stop.hour, minute: stop.minute }),
    durationMinutes: Math.max(1, durationMinutes)
  };
}

function isTimerDue(entry, now = new Date(), timeZone = FACILITY_TIME_ZONE) {
  const schedule = timerSchedule(entry, timeZone);
  const current = zonedParts(now, timeZone);
  if (!schedule || !current) return false;
  return dateTimeKey(current) >= schedule.key;
}

async function loadOpenTimerEntries(fetcher = fetch) {
  const params = new URLSearchParams({
    select: "id,system_type,start_at,timer_stop",
    set_a_timer: "eq.true",
    turn_heater_on: "eq.On",
    start_at: "not.is.null",
    timer_stop: "not.is.null",
    end_at: "is.null",
    order: "start_at.asc",
    limit: "100"
  });
  const response = await fetcher(`${SUPABASE_URL}/rest/v1/heater_use_entries?${params.toString()}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not load thermostat timers: ${response.status} ${text}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Could not load thermostat timers: invalid response.");
  return rows;
}

async function dispatchDueTimers({
  now = new Date(),
  fetcher = fetch,
  executeOff = executeHeaterOff
} = {}) {
  const entries = await loadOpenTimerEntries(fetcher);
  const due = entries.filter((entry) => isTimerDue(entry, now));
  const results = [];

  for (const entry of due) {
    const schedule = timerSchedule(entry);
    try {
      const result = await executeOff({
        requestedSystemType: entry.system_type,
        heaterUseEntryId: entry.id,
        timerTriggered: true,
        timerMinutes: schedule?.durationMinutes || 0,
        closeEntry: true,
        endAt: now.toISOString()
      });
      results.push({ id: entry.id, success: true, duplicate: Boolean(result?.duplicate) });
    } catch (error) {
      console.error(`Thermostat timer ${entry.id} failed`, error);
      results.push({ id: entry.id, success: false, error: error.message || "Timer shutdown failed" });
    }
  }

  return {
    checkedCount: entries.length,
    dueCount: due.length,
    completedCount: results.filter((result) => result.success).length,
    failedCount: results.filter((result) => !result.success).length,
    results
  };
}

async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
  if (!authorized(req)) return res.status(401).json({ success: false, error: "Unauthorized" });
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Supabase service access is not configured" });
  }

  try {
    const result = await dispatchDueTimers();
    return res.status(200).json({ success: true, ...result, completedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Thermostat timer dispatch failed", error);
    return res.status(500).json({ success: false, error: error.message || "Thermostat timer dispatch failed" });
  }
}

module.exports = handler;
module.exports.authorized = authorized;
module.exports.dispatchDueTimers = dispatchDueTimers;
module.exports.isTimerDue = isTimerDue;
module.exports.timerSchedule = timerSchedule;
