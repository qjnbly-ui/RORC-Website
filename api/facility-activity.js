const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FACILITY_TIME_ZONE = "America/Los_Angeles";

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
    const [occupancyRows, todayCount, weekCount, monthCount, members] = await Promise.all([
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
      supabaseRest("account_member_profiles?select=account_member_id,account_id,account_type&limit=10000")
    ]);

    const membership = summarizeMembership(members || []);
    const occupancyCount = Array.isArray(occupancyRows) ? occupancyRows.length : 0;

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

function summarizeMembership(rows) {
  const activeRows = rows.filter((row) => canonicalAccountType(row.account_type) === "Active Membership");
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
  if (normalized === "open gym only") return "Open Gym Only";
  return String(accountType || "").trim();
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
