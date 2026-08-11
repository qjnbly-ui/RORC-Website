const ECOBEE_CLIENT_ID = process.env.ECOBEE_CLIENT_ID || "";
const ECOBEE_ACCESS_TOKEN = process.env.ECOBEE_ACCESS_TOKEN || "";
const ECOBEE_REFRESH_TOKEN = process.env.ECOBEE_REFRESH_TOKEN || "";
const ECOBEE_AUTH_ATTEMPTS = 3;
const ECOBEE_SUMMARY_CACHE_MS = 3 * 60 * 1000;
let activeEcobeeAccessToken = ECOBEE_ACCESS_TOKEN;
let ecobeeRefreshPromise = null;
const ecobeeSummaryCache = new Map();

async function postEcobeeThermostat({ thermostatId, payload }) {
  return executeEcobeeRequest({
    thermostatId,
    request: (token) => postEcobeePayload({ token, thermostatId, payload }),
    requestErrorLabel: "Ecobee request failed",
    retryErrorLabel: "Ecobee retry failed"
  });
}

async function setEcobeeHvacMode({ thermostatId, mode }) {
  return postEcobeeThermostat({
    thermostatId,
    payload: {
      thermostat: {
        settings: {
          hvacMode: mode
        }
      }
    }
  });
}

async function stopEcobeeHvac({ thermostatId }) {
  return postEcobeeThermostat({
    thermostatId,
    payload: {
      thermostat: {
        settings: {
          hvacMode: "off"
        }
      },
      functions: [
        {
          type: "resumeProgram",
          params: {
            resumeAll: false
          }
        }
      ]
    }
  });
}

async function setEcobeeFanHold({ thermostatId, fan = "on", holdType = "indefinite" }) {
  const thermostat = await getEcobeeThermostat({
    thermostatId,
    includeSettings: false,
    includeSensors: false,
    includeWeather: false,
    includeEvents: false,
    includeEquipmentStatus: false
  });
  const { heatHoldTemp, coolHoldTemp } = currentHoldTemperatures(thermostat);

  return postEcobeeThermostat({
    thermostatId,
    payload: {
      functions: [
        {
          type: "setHold",
          params: {
            holdType,
            heatHoldTemp,
            coolHoldTemp,
            fan
          }
        }
      ]
    }
  });
}

async function setEcobeeTemperatureHold({
  thermostatId,
  mode,
  targetTemperatureF,
  holdType = "indefinite"
}) {
  const thermostat = await getEcobeeThermostat({
    thermostatId,
    includeSettings: false,
    includeSensors: false,
    includeWeather: false,
    includeEvents: false,
    includeEquipmentStatus: false
  });
  const runtime = thermostat?.runtime || {};
  const current = currentHoldTemperatures(thermostat);
  const target = toEcobeeTemp(targetTemperatureF);
  const heatRange = validRange(runtime.desiredHeatRange, [450, 790]);
  const coolRange = validRange(runtime.desiredCoolRange, [650, 920]);
  const heatHoldTemp = mode === "heat"
    ? clamp(target, heatRange)
    : current.heatHoldTemp;
  const coolHoldTemp = mode === "cool"
    ? clamp(target, coolRange)
    : current.coolHoldTemp;

  return postEcobeeThermostat({
    thermostatId,
    payload: {
      thermostat: {
        settings: {
          hvacMode: mode
        }
      },
      functions: [
        {
          type: "setHold",
          params: {
            holdType,
            heatHoldTemp,
            coolHoldTemp
          }
        }
      ]
    }
  });
}

async function resumeEcobeeProgram({ thermostatId }) {
  return postEcobeeThermostat({
    thermostatId,
    payload: {
      functions: [
        {
          type: "resumeProgram",
          params: {
            resumeAll: false
          }
        }
      ]
    }
  });
}

async function getEcobeeThermostat({
  thermostatId,
  includeSettings = true,
  includeRuntime = true,
  includeSensors = true,
  includeWeather = true,
  includeEvents = true,
  includeEquipmentStatus = true
}) {
  const result = await executeEcobeeRequest({
    thermostatId,
    request: (token) => getEcobeeThermostatWithToken({
      token,
      thermostatId,
      includeSettings,
      includeRuntime,
      includeSensors,
      includeWeather,
      includeEvents,
      includeEquipmentStatus
    }),
    requestErrorLabel: "Ecobee status request failed",
    retryErrorLabel: "Ecobee status retry failed"
  });
  if (!result.thermostat) {
    throw new Error("Ecobee did not return the requested thermostat.");
  }
  return result.thermostat;
}

async function getEcobeeThermostatSummary({ thermostatId }) {
  const cacheKey = String(thermostatId || "").trim();
  const cached = ecobeeSummaryCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < ECOBEE_SUMMARY_CACHE_MS) {
    return cached.summary;
  }

  const result = await executeEcobeeRequest({
    thermostatId,
    request: (token) => getEcobeeThermostatSummaryWithToken({ token, thermostatId }),
    requestErrorLabel: "Ecobee summary request failed",
    retryErrorLabel: "Ecobee summary retry failed"
  });
  ecobeeSummaryCache.set(cacheKey, { cachedAt: Date.now(), summary: result.summary });
  return result.summary;
}

async function getEcobeeRuntimeReport({
  thermostatId,
  startDate,
  endDate,
  startInterval = 0,
  endInterval = 287,
  columns = ""
}) {
  const result = await executeEcobeeRequest({
    thermostatId,
    request: (token) => getEcobeeRuntimeReportWithToken({
      token,
      thermostatId,
      startDate,
      endDate,
      startInterval,
      endInterval,
      columns
    }),
    requestErrorLabel: "Ecobee runtime report request failed",
    retryErrorLabel: "Ecobee runtime report retry failed"
  });
  return result.report;
}

async function executeEcobeeRequest({
  thermostatId,
  request,
  requestErrorLabel,
  retryErrorLabel
}) {
  if (!ECOBEE_CLIENT_ID || !ECOBEE_REFRESH_TOKEN || !thermostatId) {
    throw new Error("Ecobee credentials are not configured. Thermostat ID is required.");
  }

  let token = activeEcobeeAccessToken;
  if (!token) token = await refreshEcobeeAccessToken("");
  let result = null;

  for (let attempt = 0; attempt < ECOBEE_AUTH_ATTEMPTS; attempt += 1) {
    result = await request(token);
    if (result.ok) return result;
    if (!isExpiredEcobeeResponse(result)) {
      throw new Error(`${requestErrorLabel}: ${result.status} ${result.text || ""}`);
    }
    if (attempt < ECOBEE_AUTH_ATTEMPTS - 1) {
      token = await refreshEcobeeAccessToken(token);
    }
  }

  throw new Error(`${retryErrorLabel}: ${result?.status || 0} ${result?.text || ""}`);
}

async function refreshEcobeeAccessToken(expiredToken) {
  if (activeEcobeeAccessToken && activeEcobeeAccessToken !== expiredToken) {
    return activeEcobeeAccessToken;
  }
  if (ecobeeRefreshPromise) return ecobeeRefreshPromise;

  const refreshRequest = refreshEcobeeToken().then((body) => {
    activeEcobeeAccessToken = body.access_token;
    return activeEcobeeAccessToken;
  });
  ecobeeRefreshPromise = refreshRequest;
  try {
    return await refreshRequest;
  } finally {
    if (ecobeeRefreshPromise === refreshRequest) ecobeeRefreshPromise = null;
  }
}

async function postEcobeePayload({ token, thermostatId, payload }) {
  const response = await fetch("https://api.ecobee.com/1/thermostat?format=json", {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      selection: {
        selectionType: "thermostats",
        selectionMatch: thermostatId
      },
      ...payload
    })
  });

  const text = await response.text();
  const body = parseJson(text);
  return {
    ok: response.ok && Number(body?.status?.code) === 0,
    status: response.status,
    text
  };
}

async function getEcobeeThermostatWithToken({
  token,
  thermostatId,
  includeSettings,
  includeRuntime,
  includeSensors,
  includeWeather,
  includeEvents,
  includeEquipmentStatus
}) {
  const query = encodeURIComponent(JSON.stringify({
    selection: {
      selectionType: "thermostats",
      selectionMatch: thermostatId,
      includeSettings,
      includeRuntime,
      includeSensors,
      includeWeather,
      includeEvents,
      includeEquipmentStatus
    }
  }));

  return fetchEcobeeThermostatQuery({ token, query, queryParam: "json" });
}

async function getEcobeeThermostatSummaryWithToken({ token, thermostatId }) {
  const query = encodeURIComponent(JSON.stringify({
    selection: {
      selectionType: "thermostats",
      selectionMatch: thermostatId,
      includeEquipmentStatus: true
    }
  }));

  return fetchEcobeeThermostatSummaryQuery({ token, query, queryParam: "json", thermostatId });
}

async function fetchEcobeeThermostatQuery({ token, query, queryParam }) {
  const response = await fetch(`https://api.ecobee.com/1/thermostat?format=json&${queryParam}=${query}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${token}`
    }
  });

  const text = await response.text();
  const body = parseJson(text);
  return {
    ok: response.ok && Number(body?.status?.code) === 0,
    status: response.status,
    text,
    thermostat: Array.isArray(body?.thermostatList) ? body.thermostatList[0] : null
  };
}

async function fetchEcobeeThermostatSummaryQuery({ token, query, queryParam, thermostatId }) {
  const response = await fetch(`https://api.ecobee.com/1/thermostatSummary?format=json&${queryParam}=${query}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${token}`
    }
  });

  const text = await response.text();
  const body = parseJson(text);
  return {
    ok: response.ok && Number(body?.status?.code) === 0,
    status: response.status,
    text,
    summary: parseThermostatSummary(body, thermostatId)
  };
}

async function getEcobeeRuntimeReportWithToken({
  token,
  thermostatId,
  startDate,
  endDate,
  startInterval,
  endInterval,
  columns
}) {
  const query = encodeURIComponent(JSON.stringify({
    selection: {
      selectionType: "thermostats",
      selectionMatch: thermostatId
    },
    startDate,
    startInterval,
    endDate,
    endInterval,
    columns
  }));

  return fetchEcobeeRuntimeReportQuery({ token, query, queryParam: "body" });
}

async function fetchEcobeeRuntimeReportQuery({ token, query, queryParam }) {
  const response = await fetch(`https://api.ecobee.com/1/runtimeReport?format=json&${queryParam}=${query}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${token}`
    }
  });

  const text = await response.text();
  const body = parseJson(text);
  return {
    ok: response.ok && Number(body?.status?.code) === 0,
    status: response.status,
    text,
    report: body
  };
}

function parseThermostatSummary(body, thermostatId) {
  const revisionRows = Array.isArray(body?.revisionList) ? body.revisionList : [];
  const statusRows = Array.isArray(body?.statusList) ? body.statusList : [];
  const revisionRow = findCsvRowForThermostat(revisionRows, thermostatId);
  const statusRow = findCsvRowForThermostat(statusRows, thermostatId);
  const revisionParts = revisionRow ? String(revisionRow).split(":") : [];
  const statusParts = statusRow ? String(statusRow).split(":") : [];

  return {
    id: revisionParts[0] || thermostatId,
    name: revisionParts[1] || "",
    connected: String(revisionParts[2] || "").toLowerCase() === "true",
    thermostatRevision: revisionParts[3] || "",
    alertsRevision: revisionParts[4] || "",
    runtimeRevision: revisionParts[5] || "",
    intervalRevision: revisionParts[6] || "",
    equipmentStatus: statusParts.slice(1).join(":").trim(),
    rawRevision: revisionRow || "",
    rawStatus: statusRow || ""
  };
}

function findCsvRowForThermostat(rows, thermostatId) {
  const prefix = `${thermostatId}:`;
  return rows.find((row) => String(row || "").startsWith(prefix)) || rows[0] || "";
}

function isExpiredEcobeeResponse(result) {
  const text = result?.text || "";
  return result?.status === 401
    || /"code"\s*:\s*14(?:\D|$)/.test(text)
    || text.toLowerCase().includes("authentication token has expired");
}

function currentHoldTemperatures(thermostat) {
  const runtime = thermostat?.runtime || {};
  const heatRange = validRange(runtime.desiredHeatRange, [450, 790]);
  const coolRange = validRange(runtime.desiredCoolRange, [650, 920]);
  const desiredHeat = Number(runtime.desiredHeat || 0) || heatRange[0];
  const desiredCool = Number(runtime.desiredCool || 0) || coolRange[1];
  return {
    heatHoldTemp: clamp(desiredHeat, heatRange),
    coolHoldTemp: clamp(desiredCool, coolRange)
  };
}

async function refreshEcobeeToken() {
  const payload = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: ECOBEE_REFRESH_TOKEN,
    client_id: ECOBEE_CLIENT_ID
  });

  const response = await fetch("https://api.ecobee.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload.toString()
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Ecobee token refresh failed: ${response.status} ${text}`);
  }

  const body = parseJson(text);
  if (!body.access_token) {
    throw new Error("Ecobee token refresh did not return access_token.");
  }

  return body;
}

function toEcobeeTemp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error("Target temperature is required.");
  }

  return Math.round(numeric * 10);
}

function validRange(value, fallback) {
  if (!Array.isArray(value) || value.length < 2) return fallback;

  const min = Number(value[0]);
  const max = Number(value[1]);
  return Number.isFinite(min) && Number.isFinite(max) && min < max ? [min, max] : fallback;
}

function clamp(value, [min, max]) {
  return Math.min(max, Math.max(min, value));
}

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

module.exports = {
  getEcobeeRuntimeReport,
  getEcobeeThermostat,
  getEcobeeThermostatSummary,
  resumeEcobeeProgram,
  setEcobeeFanHold,
  setEcobeeHvacMode,
  setEcobeeTemperatureHold,
  stopEcobeeHvac
};
