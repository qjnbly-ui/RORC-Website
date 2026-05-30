const ECOBEE_CLIENT_ID = process.env.ECOBEE_CLIENT_ID || "";
const ECOBEE_ACCESS_TOKEN = process.env.ECOBEE_ACCESS_TOKEN || "";
const ECOBEE_REFRESH_TOKEN = process.env.ECOBEE_REFRESH_TOKEN || "";

async function postEcobeeThermostat({ thermostatId, payload }) {
  if (!ECOBEE_CLIENT_ID || !ECOBEE_ACCESS_TOKEN || !ECOBEE_REFRESH_TOKEN || !thermostatId) {
    throw new Error("Ecobee credentials are not configured. Thermostat ID is required.");
  }

  let token = ECOBEE_ACCESS_TOKEN;
  let result = await postEcobeePayload({ token, thermostatId, payload });

  if (result.ok) return result;

  const bodyText = result.text || "";
  const expired = result.status === 401
    || bodyText.includes('"code":14')
    || bodyText.toLowerCase().includes("authentication token has expired");

  if (!expired) {
    throw new Error(`Ecobee request failed: ${result.status} ${bodyText}`);
  }

  const refreshed = await refreshEcobeeToken();
  token = refreshed.access_token;
  result = await postEcobeePayload({ token, thermostatId, payload });

  if (!result.ok) {
    throw new Error(`Ecobee retry failed: ${result.status} ${result.text || ""}`);
  }

  return result;
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

async function setEcobeeFanHold({ thermostatId, fan = "on", holdType = "indefinite" }) {
  return postEcobeeThermostat({
    thermostatId,
    payload: {
      functions: [
        {
          type: "setHold",
          params: {
            holdType,
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
  const thermostat = await getEcobeeThermostat({ thermostatId });
  const runtime = thermostat?.runtime || {};
  const target = toEcobeeTemp(targetTemperatureF);
  const heatRange = validRange(runtime.desiredHeatRange, [450, 790]);
  const coolRange = validRange(runtime.desiredCoolRange, [650, 920]);
  const currentHeat = Number(runtime.desiredHeat || 0) || heatRange[0];
  const currentCool = Number(runtime.desiredCool || 0) || coolRange[1];
  const heatHoldTemp = mode === "heat"
    ? clamp(target, heatRange)
    : clamp(currentHeat, heatRange);
  const coolHoldTemp = mode === "cool"
    ? clamp(target, coolRange)
    : clamp(currentCool, coolRange);

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
          type: "resumeProgram"
        }
      ]
    }
  });
}

async function getEcobeeThermostat({ thermostatId }) {
  if (!ECOBEE_CLIENT_ID || !ECOBEE_ACCESS_TOKEN || !ECOBEE_REFRESH_TOKEN || !thermostatId) {
    throw new Error("Ecobee credentials are not configured. Thermostat ID is required.");
  }

  let token = ECOBEE_ACCESS_TOKEN;
  let result = await getEcobeeThermostatWithToken({ token, thermostatId });

  if (result.ok) return result.thermostat;

  const bodyText = result.text || "";
  const expired = result.status === 401
    || bodyText.includes('"code":14')
    || bodyText.toLowerCase().includes("authentication token has expired");

  if (!expired) {
    throw new Error(`Ecobee status request failed: ${result.status} ${bodyText}`);
  }

  const refreshed = await refreshEcobeeToken();
  token = refreshed.access_token;
  result = await getEcobeeThermostatWithToken({ token, thermostatId });

  if (!result.ok) {
    throw new Error(`Ecobee status retry failed: ${result.status} ${result.text || ""}`);
  }

  return result.thermostat;
}

async function getEcobeeThermostatSummary({ thermostatId }) {
  if (!ECOBEE_CLIENT_ID || !ECOBEE_ACCESS_TOKEN || !ECOBEE_REFRESH_TOKEN || !thermostatId) {
    throw new Error("Ecobee credentials are not configured. Thermostat ID is required.");
  }

  let token = ECOBEE_ACCESS_TOKEN;
  let result = await getEcobeeThermostatSummaryWithToken({ token, thermostatId });

  if (result.ok) return result.summary;

  const bodyText = result.text || "";
  const expired = result.status === 401
    || bodyText.includes('"code":14')
    || bodyText.toLowerCase().includes("authentication token has expired");

  if (!expired) {
    throw new Error(`Ecobee summary request failed: ${result.status} ${bodyText}`);
  }

  const refreshed = await refreshEcobeeToken();
  token = refreshed.access_token;
  result = await getEcobeeThermostatSummaryWithToken({ token, thermostatId });

  if (!result.ok) {
    throw new Error(`Ecobee summary retry failed: ${result.status} ${result.text || ""}`);
  }

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
  if (!ECOBEE_CLIENT_ID || !ECOBEE_ACCESS_TOKEN || !ECOBEE_REFRESH_TOKEN || !thermostatId) {
    throw new Error("Ecobee credentials are not configured. Thermostat ID is required.");
  }

  let token = ECOBEE_ACCESS_TOKEN;
  let result = await getEcobeeRuntimeReportWithToken({
    token,
    thermostatId,
    startDate,
    endDate,
    startInterval,
    endInterval,
    columns
  });

  if (result.ok) return result.report;

  const bodyText = result.text || "";
  const expired = result.status === 401
    || bodyText.includes('"code":14')
    || bodyText.toLowerCase().includes("authentication token has expired");

  if (!expired) {
    throw new Error(`Ecobee runtime report request failed: ${result.status} ${bodyText}`);
  }

  const refreshed = await refreshEcobeeToken();
  token = refreshed.access_token;
  result = await getEcobeeRuntimeReportWithToken({
    token,
    thermostatId,
    startDate,
    endDate,
    startInterval,
    endInterval,
    columns
  });

  if (!result.ok) {
    throw new Error(`Ecobee runtime report retry failed: ${result.status} ${result.text || ""}`);
  }

  return result.report;
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
    ok: response.ok && Number(body?.status?.code || 0) === 0,
    status: response.status,
    text
  };
}

async function getEcobeeThermostatWithToken({ token, thermostatId }) {
  const query = encodeURIComponent(JSON.stringify({
    selection: {
      selectionType: "thermostats",
      selectionMatch: thermostatId,
      includeSettings: true,
      includeRuntime: true,
      includeSensors: true,
      includeWeather: true,
      includeEvents: true,
      includeEquipmentStatus: true
    }
  }));

  let result = await fetchEcobeeThermostatQuery({ token, query, queryParam: "json" });
  if (!result.ok) {
    const fallback = await fetchEcobeeThermostatQuery({ token, query, queryParam: "body" });
    if (fallback.ok || !isExpiredEcobeeResponse(result)) {
      result = fallback;
    }
  }

  return result;
}

async function getEcobeeThermostatSummaryWithToken({ token, thermostatId }) {
  const query = encodeURIComponent(JSON.stringify({
    selection: {
      selectionType: "thermostats",
      selectionMatch: thermostatId,
      includeEquipmentStatus: true
    }
  }));

  let result = await fetchEcobeeThermostatSummaryQuery({ token, query, queryParam: "json", thermostatId });
  if (!result.ok) {
    const fallback = await fetchEcobeeThermostatSummaryQuery({ token, query, queryParam: "body", thermostatId });
    if (fallback.ok || !isExpiredEcobeeResponse(result)) {
      result = fallback;
    }
  }

  return result;
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
    ok: response.ok && Number(body?.status?.code || 0) === 0,
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
    ok: response.ok && Number(body?.status?.code || 0) === 0,
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

  let result = await fetchEcobeeRuntimeReportQuery({ token, query, queryParam: "json" });
  if (!result.ok) {
    const fallback = await fetchEcobeeRuntimeReportQuery({ token, query, queryParam: "body" });
    if (fallback.ok || !isExpiredEcobeeResponse(result)) {
      result = fallback;
    }
  }
  return result;
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
    ok: response.ok && Number(body?.status?.code || 0) === 0,
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
    || text.includes('"code":14')
    || text.toLowerCase().includes("authentication token has expired");
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
  setEcobeeTemperatureHold
};
