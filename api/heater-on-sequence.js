const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const { setEcobeeHvacMode, setEcobeeTemperatureHold } = require("./_ecobee-client");
const ECOBEE_HEATER_THERMOSTAT_ID = process.env.ECOBEE_HEATER_THERMOSTAT_ID || process.env.ECOBEE_THERMOSTAT_ID || "";
const ECOBEE_AC_THERMOSTAT_ID = process.env.ECOBEE_AC_THERMOSTAT_ID || "";

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
    const sender = await getAccountMemberByAuthUserId(user.id);
    if (!sender?.id) {
      return res.status(404).json({ success: false, error: "Member profile not found." });
    }

    const settings = await getAutomationConfig("heater_on");
    const systemType = normalizeSystemType(req.body?.systemType);
    const systemAccess = await getAutomationConfig("thermostat_system_access");
    const targetTemperatureF = Number(req.body?.targetTemperatureF || 0) || null;
    const silent = Boolean(req.body?.silent);

    if (!silent && settings.enabled === false) {
      return res.status(200).json({ success: true, skipped: true });
    }
    if (systemType === "ac" && systemAccess.ac_enabled === false) {
      return res.status(403).json({ success: false, error: "AC is currently disabled by admin settings." });
    }
    if (systemType === "heat" && systemAccess.heat_enabled === false) {
      return res.status(403).json({ success: false, error: "Heat is currently disabled by admin settings." });
    }

    await turnThermostatOn({ systemType, targetTemperatureF });

    if (silent) {
      return res.status(200).json({ success: true, sentCount: 0, silent: true });
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
      warnings: errors
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Server error" });
  }
};

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
  const rows = await supabaseRest(`account_members?select=id&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
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
  const thermostatId = thermostatIdForSystem(systemType);
  const mode = systemType === "ac" ? "cool" : "heat";

  if (targetTemperatureF) {
    return setEcobeeTemperatureHold({
      thermostatId,
      mode,
      targetTemperatureF
    });
  }

  return setEcobeeHvacMode({ thermostatId, mode });
}

function thermostatIdForSystem(systemType) {
  return systemType === "ac" ? ECOBEE_AC_THERMOSTAT_ID : ECOBEE_HEATER_THERMOSTAT_ID;
}

function normalizeSystemType(value) {
  return String(value || "").trim().toLowerCase() === "ac" ? "ac" : "heat";
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
