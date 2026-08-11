const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const {
  setEcobeeFanHold,
  stopEcobeeHvac
} = require("./_ecobee-client");
const { hasCurrentFacilityOccupancy } = require("./_facility-occupancy-state");
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

    const heaterUseEntryId = String(req.body?.heaterUseEntryId || "").trim();
    if (heaterUseEntryId) {
      const entry = await loadHeaterUseEntryMeta(heaterUseEntryId);
      if (entry && !await canControlThermostatRuntime(sender, entry)) {
        return res.status(403).json({ success: false, error: "You cannot control this thermostat runtime." });
      }
    }

    const result = await executeHeaterOff({
      requestedSystemType: req.body?.systemType,
      heaterUseEntryId,
      requestedMemberIds: req.body?.memberIds,
      timerTriggered: req.body?.timerTriggered,
      timerMinutes: req.body?.timerMinutes,
      silent: Boolean(req.body?.silent),
      closeEntry: Boolean(String(req.body?.heaterUseEntryId || "").trim()),
      endAt: new Date().toISOString()
    });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Server error" });
  }
}

async function executeHeaterOff({
  requestedSystemType,
  heaterUseEntryId,
  requestedMemberIds = [],
  timerTriggered = false,
  timerMinutes = 0,
  silent = false,
  closeEntry = false,
  endAt = null
}) {
  const normalizedEntryId = String(heaterUseEntryId || "").trim();
  const heaterEntryMeta = normalizedEntryId ? await loadHeaterUseEntryMeta(normalizedEntryId) : null;
  const resolvedEndAt = endAt || new Date().toISOString();

  if (closeEntry && (!heaterEntryMeta || !heaterEntryMeta.active)) {
    return { success: true, skipped: true, duplicate: true, sentCount: 0, warnings: [] };
  }

  const systemType = heaterEntryMeta?.systemType || normalizeSystemType(requestedSystemType);
  await turnThermostatOff(systemType);

  if (closeEntry) {
    const closed = await closeHeaterUseEntry(normalizedEntryId, resolvedEndAt);
    if (!closed) {
      return { success: true, skipped: true, duplicate: true, sentCount: 0, warnings: [] };
    }
  }

  const fanReconciliation = systemType === "ac"
    ? await reconcileAcFanAfterShutdown()
    : { skipped: true, reason: "not_ac", warnings: [] };
  const reconciliationWarnings = fanReconciliation.warnings || [];

  if (silent) {
    return {
      success: true,
      sentCount: 0,
      silent: true,
      warnings: reconciliationWarnings,
      fanReconciliation,
      heaterUseEntryId: normalizedEntryId || null,
      endAt: closeEntry ? resolvedEndAt : null
    };
  }

  const settings = await getAutomationConfig("heater_off");
  if (settings.enabled === false) {
    return {
      success: true,
      skipped: true,
      sentCount: 0,
      warnings: reconciliationWarnings,
      fanReconciliation,
      heaterUseEntryId: normalizedEntryId || null,
      endAt: closeEntry ? resolvedEndAt : null
    };
  }

  const requestedIds = Array.isArray(requestedMemberIds)
    ? requestedMemberIds.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  const normalizedTimerMinutes = Math.max(0, Number(timerMinutes || 0) || 0);
  const fallbackIds = requestedIds.length || !heaterEntryMeta
    ? []
    : await recipientIdsForHeaterEntry(heaterEntryMeta);
  const targetIds = [...new Set(requestedIds.length ? requestedIds : fallbackIds)];
  let sentCount = 0;
  const errors = [...reconciliationWarnings];

  if (targetIds.length) {
    const members = await loadMembersByIds(targetIds);
    const billedByMember = normalizedEntryId
      ? await loadBilledAmountByMember(normalizedEntryId)
      : new Map();
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

        const billedCents = billedByMember.get(member.id) || 0;
        const openBillingCents = openBillingByMember.get(member.id) || 0;
        const message = buildHeaterOffMessage({
          systemType,
          timerTriggered: Boolean(timerTriggered),
          timerMinutes: normalizedTimerMinutes,
          addedCents: billedCents,
          openTotalCents: openBillingCents,
          isGroupPay: Boolean(heaterEntryMeta?.groupPay) || targetIds.length > 1,
          recipientCount: targetIds.length
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

  return {
    success: true,
    sentCount,
    warnings: errors,
    fanReconciliation,
    heaterUseEntryId: normalizedEntryId || null,
    endAt: closeEntry ? resolvedEndAt : null
  };
}

async function reconcileAcFanAfterShutdown() {
  const settings = await getAutomationConfig("gym_lights_on");
  if (settings.enabled === false || settings.ac_fan_enabled === false) {
    return { skipped: true, reason: "disabled", warnings: [] };
  }

  let occupied;
  try {
    occupied = await hasCurrentFacilityOccupancy({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY
    });
  } catch (error) {
    return {
      skipped: true,
      reason: "occupancy_check_failed",
      warnings: [`AC circulation fan reconciliation skipped: ${error.message || "Could not verify occupancy."}`]
    };
  }

  if (!occupied) {
    return { skipped: true, reason: "facility_empty", occupied: false, warnings: [] };
  }

  try {
    await setEcobeeFanHold({
      thermostatId: String(settings.ac_thermostat_id || ECOBEE_AC_THERMOSTAT_ID).trim(),
      fan: "on",
      holdType: "indefinite"
    });
    return { restored: true, occupied: true, warnings: [] };
  } catch (error) {
    return {
      restored: false,
      occupied: true,
      warnings: [`AC circulation fan could not be restored: ${error.message || "Ecobee request failed."}`]
    };
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

async function loadHeaterUseEntryMeta(heaterUseEntryId) {
  const rows = await supabaseRest(
    `heater_use_entries?select=id,system_type,responsible_member_id,group_pay,set_a_timer,turn_heater_on,start_at,end_at&id=eq.${encodeURIComponent(heaterUseEntryId)}&limit=1`
  );
  const row = rows[0] || null;
  if (!row) return null;

  return {
    id: row.id,
    systemType: normalizeSystemType(row.system_type),
    responsibleMemberId: row.responsible_member_id || "",
    groupPay: Boolean(row.group_pay),
    setATimer: Boolean(row.set_a_timer),
    active: !row.end_at && String(row.turn_heater_on || "On").trim().toLowerCase() === "on"
  };
}

async function closeHeaterUseEntry(heaterUseEntryId, endAt) {
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
    body: JSON.stringify({
      end_at: endAt,
      turn_heater_on: "Off"
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not close thermostat runtime: ${response.status} ${text}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function recipientIdsForHeaterEntry(entryMeta) {
  if (!entryMeta?.id) return [];
  if (!entryMeta.groupPay) {
    return entryMeta.responsibleMemberId ? [entryMeta.responsibleMemberId] : [];
  }

  const rows = await supabaseRest(
    `heater_use_group_members?select=account_member_id&heater_use_entry_id=eq.${encodeURIComponent(entryMeta.id)}`
  );
  return (rows || []).map((row) => String(row.account_member_id || "").trim()).filter(Boolean);
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

async function loadBilledAmountByMember(heaterUseEntryId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await supabaseRest(
      `billing_line_items?select=account_member_id,amount_cents&heater_use_entry_id=eq.${encodeURIComponent(heaterUseEntryId)}`
    );
    if (rows.length > 0 || attempt === 2) {
      const totals = new Map();
      rows.forEach((row) => {
        const memberId = String(row.account_member_id || "");
        if (!memberId) return;
        const prev = totals.get(memberId) || 0;
        totals.set(memberId, prev + Number(row.amount_cents || 0));
      });
      return totals;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return new Map();
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

function buildHeaterOffMessage({
  systemType,
  timerTriggered,
  timerMinutes,
  addedCents,
  openTotalCents,
  isGroupPay,
  recipientCount
}) {
  const systemLabel = systemType === "ac" ? "AC" : "heater";
  const addedText = formatCurrencyFromCents(addedCents);
  const totalText = formatCurrencyFromCents(openTotalCents);

  if (timerTriggered) {
    return [
      `Your ${Math.max(1, Math.round(timerMinutes))} min ${systemLabel} timer finished and the thermostat was turned off.`,
      `${addedText} was added to your monthly bill.`,
      `Your current open billing total is ${totalText}.`
    ].join(" ");
  }

  if (isGroupPay || recipientCount > 1) {
    return [
      `The shared/group ${systemLabel} use record has been completed and the thermostat was turned off.`,
      `${addedText} was added to your monthly bill.`,
      `Your current open billing total is ${totalText}.`
    ].join(" ");
  }

  if (addedCents > 0) {
    return [
      `Your ${systemLabel} use record has been completed and the thermostat was turned off.`,
      `${addedText} was added to your monthly bill.`,
      `Your current open billing total is ${totalText}.`
    ].join(" ");
  }

  return [
    `A ${systemLabel} off record was submitted under your name.`,
    `${addedText} was added to your monthly bill.`,
    `Your current open billing total is ${totalText}.`
  ].join(" ");
}

function formatCurrencyFromCents(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

async function turnThermostatOff(systemType) {
  const normalizedSystemType = normalizeSystemType(systemType);
  const thermostatId = thermostatIdForSystem(normalizedSystemType);

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
module.exports.executeHeaterOff = executeHeaterOff;
module.exports.reconcileAcFanAfterShutdown = reconcileAcFanAfterShutdown;
