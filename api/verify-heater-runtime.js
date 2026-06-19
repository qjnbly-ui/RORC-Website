const { getEcobeeRuntimeReport } = require("./_ecobee-client");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ECOBEE_HEATER_THERMOSTAT_ID = process.env.ECOBEE_HEATER_THERMOSTAT_ID || process.env.ECOBEE_THERMOSTAT_ID || "";
const ECOBEE_AC_THERMOSTAT_ID = process.env.ECOBEE_AC_THERMOSTAT_ID || "";

const RUNTIME_CACHE_MS = 15 * 60 * 1000;
const ECOBEE_RUNTIME_MAX_DAYS = 31;
const runtimeCache = new Map();

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token" });
    }

    const user = await getSupabaseUser(token);
    const manager = await getAccountMemberByAuthUserId(user.id);
    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Only Account Managers can verify runtime." });
    }

    const systemType = normalizeSystemType(req.body?.systemType);
    const startAt = String(req.body?.startAt || "").trim();
    const endAt = String(req.body?.endAt || "").trim();

    if (!startAt || !endAt) {
      return res.status(400).json({ success: false, error: "startAt and endAt are required." });
    }

    const startDate = new Date(startAt);
    const endDate = new Date(endAt);
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
      return res.status(400).json({ success: false, error: "Invalid runtime window." });
    }
    if ((endDate.getTime() - startDate.getTime()) > ECOBEE_RUNTIME_MAX_DAYS * 24 * 60 * 60 * 1000) {
      return res.status(400).json({
        success: false,
        error: `Ecobee runtime reports can only cover up to ${ECOBEE_RUNTIME_MAX_DAYS} days at a time. Narrow Start At and End At before verifying.`
      });
    }

    const thermostatId = thermostatIdForSystem(systemType);
    const reportQuery = buildRuntimeQuery(startDate, endDate, systemType);
    const cacheKey = [thermostatId, reportQuery.startDate, reportQuery.endDate, reportQuery.startInterval, reportQuery.endInterval].join("|");
    const cached = runtimeCache.get(cacheKey);
    let report;

    if (cached && Date.now() - cached.cachedAt < RUNTIME_CACHE_MS) {
      report = cached.report;
    } else {
      report = await requestRuntimeWithFallbacks({ thermostatId, reportQuery, systemType });
      runtimeCache.set(cacheKey, {
        cachedAt: Date.now(),
        report
      });
    }

    const totals = summarizeRuntimeReport(report, reportQuery.metricColumns);
    const verifiedRuntimeMinutes = Math.max(0, Math.round((totals.runtimeSeconds / 60) * 100) / 100);
    const projectedEndAt = new Date(startDate.getTime() + (verifiedRuntimeMinutes * 60000)).toISOString();

    return res.status(200).json({
      success: true,
      runtime: {
        systemType,
        thermostatId,
        verifiedRuntimeMinutes,
        runtimeSeconds: totals.runtimeSeconds,
        rowsMatched: totals.rowCount,
        projectedEndAt,
        fetchedAt: new Date().toISOString(),
        source: cached ? "cache" : "ecobee"
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Could not verify thermostat runtime." });
  }
};

function normalizeSystemType(value) {
  return String(value || "").trim().toLowerCase() === "ac" ? "ac" : "heat";
}

function thermostatIdForSystem(systemType) {
  if (systemType === "ac") {
    const acId = String(ECOBEE_AC_THERMOSTAT_ID || "").trim();
    if (!acId) throw new Error("AC thermostat ID is not configured.");
    return acId;
  }

  const heatId = String(ECOBEE_HEATER_THERMOSTAT_ID || "").trim();
  if (!heatId) throw new Error("Heat thermostat ID is not configured.");
  return heatId;
}

function buildRuntimeQuery(startAt, endAt, systemType = "heat") {
  const startDateUtc = `${startAt.getUTCFullYear()}-${String(startAt.getUTCMonth() + 1).padStart(2, "0")}-${String(startAt.getUTCDate()).padStart(2, "0")}`;
  const endDateUtc = `${endAt.getUTCFullYear()}-${String(endAt.getUTCMonth() + 1).padStart(2, "0")}-${String(endAt.getUTCDate()).padStart(2, "0")}`;
  const startInterval = intervalForDate(startAt);
  const endInterval = intervalForDate(endAt);
  const metricColumns = systemType === "ac"
    ? ["compCool1", "compCool2", "fan"]
    : ["auxHeat1", "auxHeat2", "auxHeat3", "compHeat1", "compHeat2", "compHeat3", "fan"];
  return {
    startDate: startDateUtc,
    endDate: endDateUtc,
    startInterval,
    endInterval,
    columns: `date,time,${metricColumns.join(",")}`,
    metricColumns
  };
}

function intervalForDate(value) {
  const hours = value.getUTCHours();
  const minutes = value.getUTCMinutes();
  return Math.max(0, Math.min(287, Math.floor(((hours * 60) + minutes) / 5)));
}

function compactDateQuery(query) {
  return {
    ...query,
    startDate: String(query.startDate || "").replaceAll("-", ""),
    endDate: String(query.endDate || "").replaceAll("-", "")
  };
}

async function requestRuntimeWithFallbacks({ thermostatId, reportQuery, systemType }) {
  const attemptQueries = buildQueryAttempts(reportQuery, systemType);
  let lastError = null;

  for (const query of attemptQueries) {
    try {
      return await getEcobeeRuntimeReport({
        thermostatId,
        startDate: query.startDate,
        startInterval: query.startInterval,
        endDate: query.endDate,
        endInterval: query.endInterval,
        columns: query.columns
      });
    } catch (error) {
      lastError = error;
    }
  }

  if (isEcobeeProcessingError(lastError)) {
    throw httpError(
      422,
      "Ecobee could not process a runtime report for that historical window. Narrow Start At and End At to the actual heater runtime; if it is an older record, Ecobee may no longer have report data for that date."
    );
  }

  throw lastError || new Error("Ecobee runtime report request failed.");
}

function isEcobeeProcessingError(error) {
  const message = String(error?.message || "");
  return message.includes('"code":3') || message.includes('"code": 3') || message.includes("Processing error");
}

function buildQueryAttempts(baseQuery, systemType) {
  const narrowMetricColumns = systemType === "ac"
    ? ["compCool1"]
    : ["auxHeat1", "compHeat1"];
  const narrowQuery = {
    ...baseQuery,
    metricColumns: narrowMetricColumns,
    columns: `date,time,${narrowMetricColumns.join(",")}`
  };
  const compactBase = compactDateQuery(baseQuery);
  const compactNarrow = compactDateQuery(narrowQuery);

  return [
    baseQuery,
    compactBase,
    narrowQuery,
    compactNarrow
  ];
}

function summarizeRuntimeReport(report, metricColumns) {
  const columns = String(report?.columns || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const reports = Array.isArray(report?.reportList) ? report.reportList : [];
  let runtimeSeconds = 0;
  let rowCount = 0;

  reports.forEach((thermostatReport) => {
    const rows = Array.isArray(thermostatReport?.rowList) ? thermostatReport.rowList : [];
    rows.forEach((row) => {
      const values = String(row || "").split(",");
      rowCount += 1;
      let rowBillableSeconds = 0;
      metricColumns.forEach((columnName) => {
        const index = columns.indexOf(columnName);
        if (index < 0) return;
        const numeric = Number(values[index] || 0);
        if (Number.isFinite(numeric) && numeric > 0) {
          rowBillableSeconds = Math.max(rowBillableSeconds, Math.min(300, numeric));
        }
      });
      runtimeSeconds += rowBillableSeconds;
    });
  });

  return { runtimeSeconds, rowCount };
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function getSupabaseUser(token) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error("Invalid session");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
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
    throw new Error(`REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
