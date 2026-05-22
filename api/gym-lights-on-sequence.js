const STEP_1_URL = "https://api-v2.voicemonkey.io/announcement?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=stage-only-announcement&text=Welcome%20to%20the%20Ruth%20Oben%20Chain%20Recreation%20center.&chime=soundbank%3A%2F%2Fsoundlibrary%2Falarms%2Fbeeps_and_bloops%2Fintro_02&voice=Joanna";
const STEP_2_URL = "https://api-v2.voicemonkey.io/trigger?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=all-lights-on";
const HALF_LIGHTS_STEP_2_URL = "https://api-v2.voicemonkey.io/trigger?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=half-the-lights-on";
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const { setEcobeeFanHold } = require("./_ecobee-client");
const ECOBEE_AC_THERMOSTAT_ID = process.env.ECOBEE_AC_THERMOSTAT_ID || "";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const memberName = String(req.body?.memberName || "Unknown").trim() || "Unknown";
    const settings = await getAutomationConfig("gym_lights_on");
    if (settings.enabled === false) {
      return res.status(200).json({ success: true, skipped: true });
    }
    const step1Url = String(settings.step1_url || STEP_1_URL);
    const halfLightsEnabled = settings.half_lights_enabled !== false;
    const halfLightsStart = String(settings.half_lights_start_time || "07:00").trim() || "07:00";
    const halfLightsEnd = String(settings.half_lights_end_time || "18:00").trim() || "18:00";
    const useHalfLights = halfLightsEnabled && isNowInLosAngelesWindow(halfLightsStart, halfLightsEnd);
    const step2Url = String(
      useHalfLights
        ? (settings.half_lights_step2_url || HALF_LIGHTS_STEP_2_URL)
        : (settings.step2_url || STEP_2_URL)
    );
    const warnings = [];

    if (settings.step1_enabled !== false) {
      const step1 = await fetch(step1Url, { method: "GET" });
      if (!step1.ok) {
        const text = await step1.text();
        throw new Error(`Step 1 failed: ${step1.status} ${text}`);
      }
    }

    if (settings.step2_enabled !== false) {
      const step2 = await fetch(step2Url, { method: "GET" });
      if (!step2.ok) {
        const text = await step2.text();
        throw new Error(`Step 2 failed: ${step2.status} ${text}`);
      }
    }

    if (settings.sms_enabled !== false) {
      const origin = `https://${req.headers.host}`;
      const step3 = await fetch(`${origin}/api/send-gym-open-text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ memberName, to: settings.sms_to || "" })
      });

      const step3Body = await step3.json().catch(() => ({}));
      if (!step3.ok || step3Body.success === false) {
        throw new Error(step3Body.error || "Step 3 failed.");
      }
    }

    if (settings.ac_fan_enabled !== false) {
      try {
        await setEcobeeFanHold({
          thermostatId: String(settings.ac_thermostat_id || ECOBEE_AC_THERMOSTAT_ID).trim(),
          fan: "on",
          holdType: "indefinite"
        });
      } catch (error) {
        warnings.push(`AC fan on failed: ${error.message || "Ecobee request failed."}`);
      }
    }

    return res.status(200).json({
      success: true,
      warnings
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Sequence failed"
    });
  }
};

async function getAutomationConfig(id) {
  if (!SERVICE_ROLE_KEY) return {};
  const params = new URLSearchParams({
    select: "config",
    id: `eq.${id}`,
    limit: "1"
  });
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

function parseTimeToMinutes(timeValue) {
  const raw = String(timeValue || "").trim();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function currentLosAngelesMinutes() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value || "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value || "0");
  return (hour * 60) + minute;
}

function isNowInLosAngelesWindow(startTime, endTime) {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  if (start == null || end == null) return false;
  const now = currentLosAngelesMinutes();
  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}
