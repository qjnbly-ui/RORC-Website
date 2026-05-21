const { getEcobeeThermostat } = require("./_ecobee-client");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ECOBEE_HEATER_THERMOSTAT_ID = process.env.ECOBEE_HEATER_THERMOSTAT_ID || process.env.ECOBEE_THERMOSTAT_ID || "";
const ECOBEE_AC_THERMOSTAT_ID = process.env.ECOBEE_AC_THERMOSTAT_ID || "";
const STATUS_CACHE_MS = 3 * 60 * 1000;
let cachedStatus = null;
let cachedStatusAt = 0;
let cachedStatusKey = "";

module.exports = async (req, res) => {
  if (req.method !== "GET") {
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
    const member = await getAccountMemberByAuthUserId(user.id);
    if (!member?.id) {
      return res.status(403).json({ success: false, error: "Signed-in member profile is not linked." });
    }

    const cacheKey = `${ECOBEE_HEATER_THERMOSTAT_ID}|${ECOBEE_AC_THERMOSTAT_ID}`;
    const refreshRequested = String(req.query?.refresh || "").trim() === "1";
    if (!refreshRequested && cachedStatus && cachedStatusKey === cacheKey && Date.now() - cachedStatusAt < STATUS_CACHE_MS) {
      return res.status(200).json(cachedStatus);
    }

    const [heater, ac] = await Promise.all([
      loadThermostatStatus("heat", ECOBEE_HEATER_THERMOSTAT_ID),
      loadThermostatStatus("ac", ECOBEE_AC_THERMOSTAT_ID)
    ]);

    cachedStatus = {
      success: true,
      thermostats: {
        heat: heater,
        ac
      },
      fetchedAt: new Date().toISOString()
    };
    cachedStatusAt = Date.now();
    cachedStatusKey = cacheKey;

    return res.status(200).json(cachedStatus);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Could not load thermostat status." });
  }
};

async function loadThermostatStatus(systemType, thermostatId) {
  if (!thermostatId) {
    return {
      systemType,
      configured: false
    };
  }

  try {
    const thermostat = await getEcobeeThermostat({ thermostatId });
    const runtime = thermostat?.runtime || {};
    const settings = thermostat?.settings || {};
    const equipmentStatus = String(thermostat?.equipmentStatus || "").trim();
    const hvacMode = String(settings.hvacMode || "").trim();
    const desiredFanMode = String(runtime.desiredFanMode || "").trim();
    const remoteSensors = normalizeRemoteSensors(thermostat?.remoteSensors);
    const weather = normalizeWeather(thermostat?.weather);
    const airQuality = normalizeAirQuality(thermostat, remoteSensors);

    return {
      systemType,
      configured: true,
      id: thermostatId,
      name: thermostat?.name || "",
      connected: thermostat?.isRegistered !== false,
      hvacMode,
      equipmentStatus,
      currentActivity: describeEquipmentStatus(equipmentStatus, hvacMode, desiredFanMode),
      isCooling: isCoolingEquipmentActive(equipmentStatus, hvacMode),
      isHeating: isHeatingEquipmentActive(equipmentStatus, hvacMode),
      isFanRunning: isFanActive(equipmentStatus, desiredFanMode),
      temperatureF: fromEcobeeTemp(runtime.actualTemperature),
      humidity: runtime.actualHumidity ?? null,
      desiredHeatF: fromEcobeeTemp(runtime.desiredHeat),
      desiredCoolF: fromEcobeeTemp(runtime.desiredCool),
      desiredFanMode,
      airQuality,
      weather,
      sensors: remoteSensors,
      activeSensorCount: remoteSensors.filter((sensor) => sensor.inUse).length,
      lastStatusModified: runtime.lastStatusModified || "",
      lastModified: thermostat?.lastModified || ""
    };
  } catch (error) {
    return {
      systemType,
      configured: true,
      id: thermostatId,
      error: error.message || "Ecobee status request failed."
    };
  }
}

function fromEcobeeTemp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric / 10);
}

function fromWeatherTemp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.abs(numeric) > 200 ? numeric / 10 : numeric);
}

function describeEquipmentStatus(equipmentStatus, hvacMode, desiredFanMode) {
  const states = [];

  if (isCoolingEquipmentActive(equipmentStatus, hvacMode)) {
    states.push("Cooling");
  }
  if (isHeatingEquipmentActive(equipmentStatus, hvacMode)) {
    states.push("Heating");
  }
  if (isFanActive(equipmentStatus, desiredFanMode)) {
    states.push("Fan running");
  }
  const parts = equipmentParts(equipmentStatus);
  if (parts.some((part) => part.includes("humidifier"))) {
    states.push("Humidifying");
  }
  if (parts.some((part) => part.includes("dehumidifier"))) {
    states.push("Dehumidifying");
  }
  if (parts.some((part) => part.includes("ventilator"))) {
    states.push("Ventilating");
  }

  if (states.length) return [...new Set(states)].join(" + ");
  if (String(hvacMode || "").toLowerCase() === "off") return "Off";
  if (String(desiredFanMode || "").toLowerCase() === "on") return "Fan circulating";
  return "Idle";
}

function equipmentParts(equipmentStatus) {
  return String(equipmentStatus || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function isCoolingEquipmentActive(equipmentStatus, hvacMode) {
  const mode = String(hvacMode || "").toLowerCase();
  const parts = equipmentParts(equipmentStatus);
  const compressorRunning = parts.some((part) => part.includes("comp"));
  const heatPumpRunning = parts.some((part) => part.includes("heatpump"));
  return parts.some((part) => part.includes("cool")) || (mode === "cool" && (compressorRunning || heatPumpRunning));
}

function isHeatingEquipmentActive(equipmentStatus, hvacMode) {
  const mode = String(hvacMode || "").toLowerCase();
  const parts = equipmentParts(equipmentStatus);
  const compressorRunning = parts.some((part) => part.includes("comp"));
  const heatPumpRunning = parts.some((part) => part.includes("heatpump"));
  return parts.some((part) => part.includes("aux") || (part.includes("heat") && !part.includes("heatpump")))
    || (mode === "heat" && (compressorRunning || heatPumpRunning));
}

function isFanActive(equipmentStatus, desiredFanMode) {
  const parts = equipmentParts(equipmentStatus);
  return parts.some((part) => part.includes("fan") || part.includes("blower"))
    || String(desiredFanMode || "").toLowerCase() === "on";
}

function normalizeRemoteSensors(sensors) {
  if (!Array.isArray(sensors)) return [];

  return sensors.map((sensor) => {
    const capabilities = Array.isArray(sensor?.capability) ? sensor.capability : [];
    const capabilityMap = capabilities.reduce((map, capability) => {
      const type = String(capability?.type || "").trim().toLowerCase();
      if (type) {
        map[type] = capability?.value;
      }
      return map;
    }, {});

    return {
      id: sensor?.id || "",
      name: sensor?.name || "Sensor",
      type: sensor?.type || "",
      inUse: Boolean(sensor?.inUse),
      temperatureF: fromEcobeeTemp(capabilityMap.temperature),
      humidity: normalizedNumber(capabilityMap.humidity),
      occupancy: normalizeOccupancy(capabilityMap.occupancy),
      co2: normalizedNumber(capabilityMap.co2),
      airQuality: normalizedNumber(capabilityMap.airquality ?? capabilityMap.air_quality)
    };
  });
}

function normalizeWeather(weather) {
  const forecast = Array.isArray(weather?.forecasts) ? weather.forecasts[0] : null;
  if (!forecast) return null;

  return {
    condition: forecast.condition || "",
    temperatureF: fromWeatherTemp(forecast.temperature),
    humidity: normalizedNumber(forecast.relativeHumidity),
    windMph: normalizedNumber(forecast.windSpeed),
    pressure: normalizedNumber(forecast.pressure),
    timestamp: weather?.timestamp || ""
  };
}

function normalizeAirQuality(thermostat, sensors) {
  const directValue = firstNumber(
    thermostat?.airQuality,
    thermostat?.indoorAirQuality,
    thermostat?.runtime?.airQuality,
    thermostat?.runtime?.actualAirQuality,
    thermostat?.settings?.airQuality,
    thermostat?.settings?.indoorAirQuality
  );
  const sensorAirQuality = firstNumber(...sensors.map((sensor) => sensor.airQuality));
  const co2 = firstNumber(...sensors.map((sensor) => sensor.co2));

  return {
    value: directValue ?? sensorAirQuality ?? null,
    co2,
    displayEnabled: thermostat?.settings?.displayAirQuality ?? null
  };
}

function normalizeOccupancy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["true", "yes", "occupied", "1"].includes(normalized)) return "occupied";
  if (["false", "no", "unoccupied", "0"].includes(normalized)) return "clear";
  return normalized;
}

function normalizedNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = normalizedNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
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
    throw new Error("Invalid Supabase session");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(`account_members?select=id&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
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
