const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const {
  setEcobeeHvacMode,
  setEcobeeTemperatureHold,
  stopEcobeeHvac
} = require("./_ecobee-client");
const ECOBEE_HEATER_THERMOSTAT_ID = process.env.ECOBEE_HEATER_THERMOSTAT_ID || process.env.ECOBEE_THERMOSTAT_ID || "";
const ECOBEE_AC_THERMOSTAT_ID = process.env.ECOBEE_AC_THERMOSTAT_ID || "";

async function handler(req, res) {
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
    const sender = await getAccountMemberByAuthUserId(user.id);
    if (!sender?.id) {
      return res.status(404).json({ success: false, error: "Member profile not found." });
    }

    const action = normalizeAction(req.body?.action);
    const requestedSystemType = normalizeSystemType(req.body?.systemType);
    const heaterUseEntryId = String(req.body?.heaterUseEntryId || "").trim();
    const entry = heaterUseEntryId
      ? await loadHeaterUseEntryMeta(heaterUseEntryId)
      : action === "start"
        ? await loadActiveHeaterUseEntry(requestedSystemType)
        : null;
    if (!entry) {
      const error = heaterUseEntryId
        ? "Thermostat runtime record not found."
        : "A matching active thermostat runtime record is required.";
      return res.status(heaterUseEntryId ? 404 : 400).json({ success: false, error });
    }
    if (!entry.active) {
      return res.status(409).json({ success: false, error: "Thermostat runtime is no longer active." });
    }
    if (!await canControlThermostatRuntime(sender, entry)) {
      return res.status(403).json({ success: false, error: "You cannot control this thermostat runtime." });
    }

    if (requestedSystemType !== entry.systemType) {
      return res.status(409).json({ success: false, error: "Thermostat runtime does not match the requested system." });
    }

    if (action === "cancel") {
      await closeHeaterUseEntry(entry.id, entry.startAt || new Date().toISOString());
      return res.status(200).json({ success: true, canceled: true, heaterUseEntryId: entry.id });
    }

    const settings = await getAutomationConfig("heater_on");
    const systemType = entry.systemType;
    const systemAccess = await getAutomationConfig("thermostat_system_access");
    const targetTemperatureF = Number(req.body?.targetTemperatureF || 0) || null;
    const silent = Boolean(req.body?.silent);

    if (systemType === "ac" && systemAccess.ac_enabled === false) {
      return res.status(403).json({ success: false, error: "AC is currently disabled by admin settings." });
    }
    if (systemType === "heat" && systemAccess.heat_enabled === false) {
      return res.status(403).json({ success: false, error: "Heat is currently disabled by admin settings." });
    }

    validateTargetTemperature(systemType, targetTemperatureF);

    if (action === "temperature") {
      await changeThermostatTemperature({ entry, targetTemperatureF });
    } else {
      await startThermostatRuntime({ entry, targetTemperatureF });
    }

    if (silent || settings.enabled === false) {
      return res.status(200).json({
        success: true,
        sentCount: 0,
        silent: true,
        heaterUseEntryId: entry.id,
        targetTemperatureF
      });
    }

    const requestedIds = Array.isArray(req.body?.memberIds)
      ? req.body.memberIds.map((v) => String(v || "").trim()).filter(Boolean)
      : [];

    const targetIds = [...new Set(requestedIds)];
    let sentCount = 0;
    const errors = [];

    if (targetIds.length) {
      const members = await loadMembersByIds(targetIds);
      const openBillingByMember = await loadOpenBillingTotalsByMember(targetIds);

      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        errors.push("Twilio credentials are not configured.");
      } else {
        for (const member of members) {
          const to = normalizePhone(member.phone_number);
          if (!to) {
            errors.push(`${member.member_name || member.id}: no valid phone number`);
            continue;
          }

          const openBillingCents = openBillingByMember.get(member.id) || 0;
          const message = buildThermostatOnMessage({
            systemType,
            targetTemperatureF,
            openBillingCents
          });

          try {
            await sendTwilioText(to, message);
            sentCount += 1;
          } catch (error) {
            errors.push(`${member.member_name || member.id}: ${error.message}`);
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      sentCount,
      warnings: errors,
      heaterUseEntryId: entry.id,
      targetTemperatureF
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Server error" });
  }
}

async function startThermostatRuntime({ entry, targetTemperatureF }) {
  try {
    await turnThermostatOn({ systemType: entry.systemType, targetTemperatureF });
  } catch (startError) {
    try {
      await turnThermostatOff(entry.systemType);
      await closeHeaterUseEntry(entry.id, entry.startAt || new Date().toISOString());
    } catch (rollbackError) {
      const combined = new Error(
        `${startError.message || "Ecobee start failed."} `
        + `Automatic shutdown could not be confirmed: ${rollbackError.message || "rollback failed"}`
      );
      combined.cause = startError;
      throw combined;
    }
    throw startError;
  }
}

async function changeThermostatTemperature({ entry, targetTemperatureF }) {
  await turnThermostatOn({ systemType: entry.systemType, targetTemperatureF });

  try {
    await updateHeaterUseEntryTemperature(entry.id, targetTemperatureF);
  } catch (updateError) {
    if (entry.targetTemperatureF) {
      try {
        await turnThermostatOn({
          systemType: entry.systemType,
          targetTemperatureF: entry.targetTemperatureF
        });
      } catch (rollbackError) {
        const combined = new Error(
          `${updateError.message || "Could not save the new thermostat temperature."} `
          + `The prior Ecobee setting could not be restored: ${rollbackError.message || "rollback failed"}`
        );
        combined.cause = updateError;
        throw combined;
      }
    }
    throw updateError;
  }
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
  const rows = await supabaseRest(
    `account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
  );
  return rows[0] || null;
}

async function loadHeaterUseEntryMeta(heaterUseEntryId) {
  const rows = await supabaseRest(
    `heater_use_entries?select=id,system_type,responsible_member_id,group_pay,target_temperature_f,turn_heater_on,start_at,end_at&id=eq.${encodeURIComponent(heaterUseEntryId)}&limit=1`
  );
  const row = rows[0] || null;
  if (!row) return null;

  return {
    id: row.id,
    systemType: normalizeSystemType(row.system_type),
    responsibleMemberId: row.responsible_member_id || "",
    groupPay: Boolean(row.group_pay),
    targetTemperatureF: Number(row.target_temperature_f || 0) || null,
    startAt: row.start_at || null,
    active: !row.end_at && String(row.turn_heater_on || "On").trim().toLowerCase() === "on"
  };
}

async function loadActiveHeaterUseEntry(systemType) {
  const rows = await supabaseRest(
    `heater_use_entries?select=id,system_type,responsible_member_id,group_pay,target_temperature_f,turn_heater_on,start_at,end_at&system_type=eq.${encodeURIComponent(normalizeSystemType(systemType))}&turn_heater_on=eq.On&end_at=is.null&order=start_at.desc&limit=1`
  );
  const row = rows[0] || null;
  if (!row) return null;

  return {
    id: row.id,
    systemType: normalizeSystemType(row.system_type),
    responsibleMemberId: row.responsible_member_id || "",
    groupPay: Boolean(row.group_pay),
    targetTemperatureF: Number(row.target_temperature_f || 0) || null,
    startAt: row.start_at || null,
    active: !row.end_at && String(row.turn_heater_on || "On").trim().toLowerCase() === "on"
  };
}

async function canControlThermostatRuntime(actor, entry) {
  const accountType = String(actor?.account_type || "").trim();
  if (["Account Manager", "Kiosk Account"].includes(accountType)) return true;
  if (entry?.responsibleMemberId && entry.responsibleMemberId === actor?.id) return true;
  if (!entry?.groupPay || !actor?.id) return false;

  const rows = await supabaseRest(
    `heater_use_group_members?select=account_member_id&heater_use_entry_id=eq.${encodeURIComponent(entry.id)}&account_member_id=eq.${encodeURIComponent(actor.id)}&limit=1`
  );
  return rows.length > 0;
}

async function closeHeaterUseEntry(heaterUseEntryId, endAt) {
  return patchHeaterUseEntry(
    heaterUseEntryId,
    { end_at: endAt, turn_heater_on: "Off" },
    "Could not cancel thermostat runtime"
  );
}

async function updateHeaterUseEntryTemperature(heaterUseEntryId, targetTemperatureF) {
  return patchHeaterUseEntry(
    heaterUseEntryId,
    { target_temperature_f: targetTemperatureF },
    "Could not save thermostat temperature"
  );
}

async function patchHeaterUseEntry(heaterUseEntryId, values, errorLabel) {
  const params = new URLSearchParams({
    id: `eq.${heaterUseEntryId}`,
    turn_heater_on: "eq.On",
    end_at: "is.null"
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/heater_use_entries?${params.toString()}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(values)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${errorLabel}: ${response.status} ${text}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${errorLabel}: runtime is no longer active.`);
  }
  return rows[0];
}

async function loadMembersByIds(memberIds) {
  const idList = memberIds.map((id) => `"${id.replaceAll("\"", "")}"`).join(",");
  return supabaseRest(`account_members?select=id,member_name,phone_number&id=in.(${encodeURIComponent(idList)})`);
}

async function getAutomationConfig(id) {
  const params = new URLSearchParams({ select: "config", id: `eq.${id}`, limit: "1" });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/automation_settings?${params.toString()}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });
  if (!response.ok) return {};
  const rows = await response.json().catch(() => []);
  return rows[0]?.config || {};
}

async function loadOpenBillingTotalsByMember(memberIds) {
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    return new Map();
  }

  const idList = memberIds.map((id) => `"${String(id).replaceAll("\"", "")}"`).join(",");
  const rows = await supabaseRest(
    `billing_line_items?select=account_member_id,amount_cents&account_member_id=in.(${encodeURIComponent(idList)})&posted_to_stripe_at=is.null`
  );

  const totals = new Map();
  rows.forEach((row) => {
    const memberId = String(row.account_member_id || "");
    if (!memberId) return;
    const prev = totals.get(memberId) || 0;
    totals.set(memberId, prev + Number(row.amount_cents || 0));
  });
  return totals;
}

function formatCurrencyFromCents(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function buildThermostatOnMessage({ systemType, targetTemperatureF, openBillingCents }) {
  const systemLabel = systemType === "ac" ? "AC" : "heater";
  return [
    `A new ${systemLabel} use record was created under your name.`,
    targetTemperatureF ? `Desired temperature: ${Math.round(targetTemperatureF)} degrees.` : "",
    "Do not forget to turn the thermostat off before leaving.",
    `Current open billing total: ${formatCurrencyFromCents(openBillingCents)}.`,
    "All use will be billed monthly."
  ].filter(Boolean).join(" ");
}

function normalizePhone(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

async function sendTwilioText(to, body) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const payload = new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload.toString()
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result?.message || "Twilio request failed.");
  }
}

async function turnThermostatOn({ systemType, targetTemperatureF }) {
  const normalizedSystemType = normalizeSystemType(systemType);
  const thermostatId = thermostatIdForSystem(normalizedSystemType);
  const mode = normalizedSystemType === "ac" ? "cool" : "heat";

  if (targetTemperatureF) {
    return setEcobeeTemperatureHold({
      thermostatId,
      mode,
      targetTemperatureF
    });
  }

  return setEcobeeHvacMode({ thermostatId, mode });
}

async function turnThermostatOff(systemType) {
  const thermostatId = thermostatIdForSystem(systemType);
  return stopEcobeeHvac({ thermostatId });
}

function thermostatIdForSystem(systemType) {
  const normalizedSystemType = normalizeSystemType(systemType);
  const acId = String(ECOBEE_AC_THERMOSTAT_ID || "").trim();
  const heatId = String(ECOBEE_HEATER_THERMOSTAT_ID || "").trim();

  if (acId && heatId && acId === heatId) {
    throw new Error("AC and Heat thermostat IDs must be different.");
  }

  if (normalizedSystemType === "ac") {
    if (!acId) throw new Error("AC thermostat ID is not configured.");
    return acId;
  }

  if (!heatId) throw new Error("Heat thermostat ID is not configured.");
  return heatId;
}

function normalizeSystemType(value) {
  return String(value || "").trim().toLowerCase() === "ac" ? "ac" : "heat";
}

function normalizeAction(value) {
  const action = String(value || "start").trim().toLowerCase();
  return ["cancel", "temperature"].includes(action) ? action : "start";
}

function validateTargetTemperature(systemType, value) {
  const target = Number(value);
  const range = normalizeSystemType(systemType) === "ac"
    ? { min: 60, max: 80 }
    : { min: 45, max: 80 };
  if (!Number.isFinite(target) || target < range.min || target > range.max) {
    throw new Error(`Temperature must be between ${range.min} and ${range.max} degrees.`);
  }
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

module.exports = handler;
module.exports.changeThermostatTemperature = changeThermostatTemperature;
module.exports.startThermostatRuntime = startThermostatRuntime;
