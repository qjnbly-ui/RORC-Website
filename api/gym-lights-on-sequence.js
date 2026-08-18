const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const GYM_OPEN_TO_NUMBER = "+15418916772";
const { setEcobeeFanHold } = require("./_ecobee-client");
const { hasActiveThermostatRuntime } = require("./_thermostat-runtime-state");
const { parseSmsDestinations } = require("./_sms-destinations");
const ECOBEE_AC_THERMOSTAT_ID = process.env.ECOBEE_AC_THERMOSTAT_ID || "";
const { requireCronAuthorization, resolveVoiceMonkeyUrl } = require("./_automation-security");
const { runAutomationStep } = require("./_automation-step");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }
  if (!requireCronAuthorization(req, res)) return;

  const completedSteps = new Set(
    Array.isArray(req.body?.completedSteps) ? req.body.completedSteps.map(String) : []
  );

  try {
    const memberName = String(req.body?.memberName || "Unknown").trim() || "Unknown";
    const settings = await getAutomationConfig("gym_lights_on");
    if (settings.enabled === false) {
      return res.status(200).json({ success: true, skipped: true });
    }
    const halfLightsEnabled = settings.half_lights_enabled !== false;
    const halfLightsStart = String(settings.half_lights_start_time || "07:00").trim() || "07:00";
    const halfLightsEnd = String(settings.half_lights_end_time || "18:00").trim() || "18:00";
    const useHalfLights = halfLightsEnabled && isNowInLosAngelesWindow(halfLightsStart, halfLightsEnd);
    const warnings = [];
    let fanAutomationSkipped = "";

    if (settings.step1_enabled !== false && !completedSteps.has("announcement")) {
      const step1Url = resolveVoiceMonkeyUrl({
        settingValue: settings.step1_url,
        environmentName: "GYM_LIGHTS_ON_ANNOUNCEMENT_URL",
        label: "Gym opening announcement URL"
      });
      await runAutomationStep({ req, completedSteps, step: "announcement", action: async () => {
        const step1 = await fetch(step1Url, { method: "GET" });
        if (!step1.ok) throw new Error(`Step 1 failed: ${step1.status} ${await step1.text()}`);
      }});
    }

    if (settings.step2_enabled !== false && !completedSteps.has("lights")) {
      const step2Url = resolveVoiceMonkeyUrl({
        settingValue: useHalfLights ? settings.half_lights_step2_url : settings.step2_url,
        environmentName: useHalfLights ? "GYM_LIGHTS_ON_HALF_URL" : "GYM_LIGHTS_ON_FULL_URL",
        label: useHalfLights ? "Half-lights opening URL" : "Full-lights opening URL"
      });
      await runAutomationStep({ req, completedSteps, step: "lights", action: async () => {
        const step2 = await fetch(step2Url, { method: "GET" });
        if (!step2.ok) throw new Error(`Step 2 failed: ${step2.status} ${await step2.text()}`);
      }});
    }

    if (settings.sms_enabled !== false && !completedSteps.has("sms")) {
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        throw new Error("Step 3 failed: Twilio credentials are not configured.");
      }

      const smsDestinations = parseSmsDestinations(settings.sms_to, GYM_OPEN_TO_NUMBER);
      const smsBody = `GYM LIGHTS ON\nMember Entered: ${memberName}`;
      const auth = Buffer
        .from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)
        .toString("base64");
      for (const [index, smsTo] of smsDestinations.entries()) {
        const recipientStep = `sms:${index}`;
        if (completedSteps.has("sms") || completedSteps.has(recipientStep)) continue;
        await runAutomationStep({ req, completedSteps, step: recipientStep, action: async () => {
        const params = new URLSearchParams({
          To: smsTo,
          From: TWILIO_FROM_NUMBER,
          Body: smsBody
        });
        const step3 = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString()
          }
        );
        const step3Body = await step3.json().catch(() => ({}));
        if (!step3.ok) {
          throw new Error(`Step 3 failed for ${smsTo}: ${step3Body?.message || "Twilio SMS request failed."}`);
        }
        }});
      }
      completedSteps.add("sms");
    }

    if (settings.ac_fan_enabled !== false && !completedSteps.has("ac_fan")) {
      await runAutomationStep({ req, completedSteps, step: "ac_fan", action: async () => {
        let acRuntimeActive = null;
        try {
          acRuntimeActive = await hasActiveThermostatRuntime({
            supabaseUrl: SUPABASE_URL,
            serviceRoleKey: SERVICE_ROLE_KEY,
            systemType: "ac"
          });
        } catch (error) {
          fanAutomationSkipped = "priority_check_failed";
          warnings.push(`AC fan on skipped: ${error.message || "Could not verify AC runtime."}`);
        }

        if (acRuntimeActive) {
          fanAutomationSkipped = "active_ac";
        } else if (acRuntimeActive === false) {
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
      }});
    }

    return res.status(200).json({
      success: true,
      completedSteps: [...completedSteps],
      fanAutomationSkipped: fanAutomationSkipped || null,
      warnings
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Sequence failed",
      completedSteps: [...completedSteps],
      inFlightStep: error.inFlightStep || null
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
