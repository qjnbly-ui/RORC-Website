const { getEcobeeThermostat, getEcobeeThermostatSummary } = require("./_ecobee-client");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FACILITY_TIME_ZONE = "America/Los_Angeles";
const HEATMAP_START_HOUR = 7;
const HEATMAP_END_HOUR = 20;
const HEATMAP_WEEKS = 8;
const ECOBEE_ROOM_THERMOSTAT_ID = process.env.ECOBEE_ROOM_THERMOSTAT_ID
  || process.env.ECOBEE_HEATER_THERMOSTAT_ID
  || process.env.ECOBEE_THERMOSTAT_ID
  || process.env.ECOBEE_AC_THERMOSTAT_ID
  || "";
const ROOM_CLIMATE_CACHE_MS = 5 * 60 * 1000;
const ROOM_CLIMATE_FULL_CACHE_MS = 15 * 60 * 1000;
let roomClimateCache = null;
let roomClimateCacheAt = 0;

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  try {
    const now = new Date();
    const range = getFacilityRanges(now);
    const trendStart = addFacilityDays(range.tomorrowStart, -(HEATMAP_WEEKS * 7));
    const [occupancyRows, todayCount, weekCount, monthCount, members, trendRows, roomClimate] = await Promise.all([
      supabaseRest("timesheet_entries?select=id&signed_out_at=is.null&limit=10000"),
      countRows("timesheet_entries", {
        signed_in_at: [`gte.${range.todayStart.toISOString()}`, `lt.${range.tomorrowStart.toISOString()}`]
      }),
      countRows("timesheet_entries", {
        signed_in_at: [`gte.${range.weekStart.toISOString()}`, `lt.${range.tomorrowStart.toISOString()}`]
      }),
      countRows("timesheet_entries", {
        signed_in_at: [`gte.${range.monthStart.toISOString()}`, `lt.${range.nextMonthStart.toISOString()}`]
      }),
      supabaseRest("account_member_profiles?select=account_member_id,account_id,account_type&limit=10000"),
      supabaseRest(`timesheet_entries?select=signed_in_at&signed_in_at=gte.${encodeURIComponent(trendStart.toISOString())}&order=signed_in_at.desc&limit=10000`),
      loadRoomClimate()
    ]);

    const membership = summarizeMembership(members || []);
    const occupancyCount = Array.isArray(occupancyRows) ? occupancyRows.length : 0;
    const weeklyTrends = buildWeeklyTrendHeatmap(trendRows || []);

    return res.status(200).json({
      success: true,
      activity: {
        occupancyCount,
        gymOccupied: occupancyCount > 0 ? "Yes" : "No",
        checkinsToday: todayCount,
        checkinsThisWeek: weekCount,
        checkinsThisMonth: monthCount,
        avgPerDayThisMonth: averagePerDay(monthCount, range.dayOfMonth),
        lastUpdated: formatFacilityTimestamp(now),
        roomTemperatureF: roomClimate.temperatureF,
        roomHumidity: roomClimate.humidity,
        roomClimateUpdatedAt: roomClimate.updatedAt,
        weeklyTrends,
        ...membership
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
};

async function loadRoomClimate() {
  const fallback = { temperatureF: null, humidity: null, updatedAt: null };
  const now = Date.now();
  if (roomClimateCache && now - roomClimateCacheAt < ROOM_CLIMATE_CACHE_MS) {
    return roomClimateCache;
  }

  if (!ECOBEE_ROOM_THERMOSTAT_ID) {
    roomClimateCache = fallback;
    roomClimateCacheAt = now;
    return roomClimateCache;
  }

  try {
    const summary = await getEcobeeThermostatSummary({ thermostatId: ECOBEE_ROOM_THERMOSTAT_ID });
    const nextSummaryKey = thermostatSummaryKey(summary);
    const previousFetchedAt = Date.parse(roomClimateCache?.fetchedAt || "");
    const previousFullStatusIsFresh = roomClimateCache
      && Number.isFinite(previousFetchedAt)
      && now - previousFetchedAt < ROOM_CLIMATE_FULL_CACHE_MS;

    if (previousFullStatusIsFresh && roomClimateCache.summaryRevisionKey === nextSummaryKey) {
      roomClimateCache = {
        ...roomClimateCache,
        connected: summary.connected,
        statusCheckedAt: new Date().toISOString()
      };
      roomClimateCacheAt = now;
      return roomClimateCache;
    }

    const thermostat = await getEcobeeThermostat({ thermostatId: ECOBEE_ROOM_THERMOSTAT_ID });
    const runtime = thermostat?.runtime || {};
    const result = {
      temperatureF: parseEcobeeTemperature(runtime.actualTemperature),
      humidity: parseOptionalNumber(runtime.actualHumidity),
      updatedAt: runtime.lastStatusModified || thermostat?.lastModified || null,
      connected: summary.connected,
      summaryRevisionKey: nextSummaryKey,
      fetchedAt: new Date().toISOString()
    };
    roomClimateCache = result;
    roomClimateCacheAt = now;
    return result;
  } catch (error) {
    console.warn("Room climate unavailable:", error?.message || error);
    return roomClimateCache || fallback;
  }
}

function thermostatSummaryKey(summary) {
  if (!summary) return "";
  return [
    summary.thermostatRevision,
    summary.runtimeRevision,
    summary.intervalRevision,
    summary.equipmentStatus,
    summary.connected
  ].map((value) => String(value ?? "")).join("|");
}

function parseEcobeeTemperature(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric / 10);
}

function parseOptionalNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function summarizeMembership(rows) {
  const activeRows = rows.filter((row) => ["Active Membership", "Work Exchange Membership Program", "Weight Room Only"].includes(canonicalAccountType(row.account_type)));
  const openGymRows = rows.filter((row) => canonicalAccountType(row.account_type) === "Open Gym Only");
  const activeAccounts = new Set(activeRows.map((row) => row.account_id).filter(Boolean));

  return {
    activeMembers: activeRows.length,
    activeMemberAccounts: activeAccounts.size,
    openGymUsers: openGymRows.length,
    totalAccountHolders: rows.length
  };
}

function averagePerDay(count, dayOfMonth) {
  const divisor = Math.max(Number(dayOfMonth) || 1, 1);
  return (Number(count || 0) / divisor).toFixed(2);
}

function getFacilityRanges(now) {
  const parts = getFacilityDateParts(now);
  const dayOfMonth = parts.day;
  const weekday = parts.weekday;
  const todayStart = facilityWallTimeToUtc(parts.year, parts.month, parts.day);
  const tomorrowStart = addFacilityDays(todayStart, 1);
  const weekStart = addFacilityDays(todayStart, -weekday);
  const monthStart = facilityWallTimeToUtc(parts.year, parts.month, 1);
  const nextMonthStart = parts.month === 12
    ? facilityWallTimeToUtc(parts.year + 1, 1, 1)
    : facilityWallTimeToUtc(parts.year, parts.month + 1, 1);

  return { todayStart, tomorrowStart, weekStart, monthStart, nextMonthStart, dayOfMonth };
}

function addFacilityDays(date, days) {
  const parts = getFacilityDateParts(date);
  const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  const targetParts = getFacilityDateParts(target);
  return facilityWallTimeToUtc(targetParts.year, targetParts.month, targetParts.day);
}

function getFacilityDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    weekday: weekdayIndex(value.weekday)
  };
}

function facilityWallTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  const wallTime = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcTime = wallTime;

  for (let i = 0; i < 3; i += 1) {
    utcTime = wallTime - getTimeZoneOffsetMs(new Date(utcTime), FACILITY_TIME_ZONE);
  }

  return new Date(utcTime);
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  }).formatToParts(date);
  const zone = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  const match = zone.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);

  if (!match) return 0;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * ((hours * 60) + minutes) * 60 * 1000;
}

function weekdayIndex(value) {
  return {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  }[value] ?? 0;
}

function formatFacilityTimestamp(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function canonicalAccountType(accountType) {
  const normalized = String(accountType || "").trim().toLowerCase();
  if (normalized === "active membership") return "Active Membership";
  if (normalized === "work exchange membership program") return "Work Exchange Membership Program";
  if (normalized === "weight room only") return "Weight Room Only";
  if (normalized === "open gym only") return "Open Gym Only";
  return String(accountType || "").trim();
}

function buildWeeklyTrendHeatmap(rows) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hours = [];
  for (let hour = HEATMAP_START_HOUR; hour <= HEATMAP_END_HOUR; hour += 1) {
    hours.push(hour);
  }

  const matrix = days.map(() => hours.map(() => 0));
  rows.forEach((row) => {
    const signedInAt = row?.signed_in_at;
    if (!signedInAt) return;
    const parts = getFacilityDateTimeParts(new Date(signedInAt));
    const dayIndex = weekdayIndex(parts.weekday);
    const hourIndex = parts.hour - HEATMAP_START_HOUR;
    if (dayIndex < 0 || hourIndex < 0 || hourIndex >= hours.length) return;
    matrix[dayIndex][hourIndex] += 1;
  });

  const flat = [];
  matrix.forEach((row, dayIndex) => {
    row.forEach((count, hourIndex) => {
      flat.push({ dayIndex, hourIndex, count });
    });
  });

  const max = flat.reduce((best, cell) => Math.max(best, cell.count), 0);
  const busiest = flat.reduce((best, cell) => (cell.count > best.count ? cell : best), flat[0] || { dayIndex: 0, hourIndex: 0, count: 0 });
  const quietest = flat.reduce((best, cell) => (cell.count < best.count ? cell : best), flat[0] || { dayIndex: 0, hourIndex: 0, count: 0 });

  return {
    weeksAnalyzed: HEATMAP_WEEKS,
    dayLabels: days,
    hourLabels: hours.map(formatHourLabel),
    matrix,
    max,
    busiest: {
      day: days[busiest.dayIndex],
      hour: formatHourLabel(hours[busiest.hourIndex]),
      count: busiest.count
    },
    quietest: {
      day: days[quietest.dayIndex],
      hour: formatHourLabel(hours[quietest.hourIndex]),
      count: quietest.count
    }
  };
}

function getFacilityDateTimeParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: value.weekday,
    hour: Number(value.hour)
  };
}

function formatHourLabel(hour24) {
  if (!Number.isInteger(hour24)) return "";
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:00 ${suffix}`;
}

async function countRows(table, filters) {
  const params = new URLSearchParams({ select: "id" });

  Object.entries(filters).forEach(([column, values]) => {
    values.forEach((value) => params.append(column, value));
  });

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params.toString()}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      Prefer: "count=exact",
      Range: "0-0"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `REST count failed: ${response.status} ${text}`);
  }

  const contentRange = response.headers.get("content-range") || "";
  const match = contentRange.match(/\/(\d+)$/);
  if (match) return Number(match[1]);

  const rows = await response.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function supabaseRest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
