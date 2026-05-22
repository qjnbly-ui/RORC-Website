const STEP_1_URL = "https://api-v2.voicemonkey.io/announcement?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=front-door-announcement&text=%20Closing%20the%20gym%20now.%20Thank%20you%20for%20spending%20time%20with%20us.%20Please%20close%20the%20door%20when%20you%20exit.%20&chime=soundbank%3A%2F%2Fsoundlibrary%2Falarms%2Fbeeps_and_bloops%2Fintro_02&voice=Matthew&character_display=%20";
const STEP_2_URL = "https://api-v2.voicemonkey.io/trigger?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=close-the-gym";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const GYM_OFF_TO_NUMBER = "+15418916772";
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const { resumeEcobeeProgram } = require("./_ecobee-client");
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
    const visitDurationMinutes = Number(req.body?.visitDurationMinutes || 0);
    const settings = await getAutomationConfig("gym_lights_off");
    if (settings.enabled === false) {
      return res.status(200).json({ success: true, skipped: true });
    }
    const step1Url = String(settings.step1_url || STEP_1_URL);
    const step2Url = String(settings.step2_url || STEP_2_URL);
    const smsTo = String(settings.sms_to || GYM_OFF_TO_NUMBER).trim() || GYM_OFF_TO_NUMBER;
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
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        throw new Error("Step 3 failed: Twilio credentials are not configured.");
      }

      const smsBody = `GYM LIGHTS OFF\nMember Last To Exit: ${memberName}\nVisit Duration: ${Math.max(0, Math.round(visitDurationMinutes))} MIN`;
      const auth = Buffer
        .from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)
        .toString("base64");
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
        throw new Error(`Step 3 failed: ${step3Body?.message || "Twilio SMS request failed."}`);
      }
    }

    if (settings.ac_fan_enabled !== false) {
      try {
        await resumeEcobeeProgram({
          thermostatId: String(settings.ac_thermostat_id || ECOBEE_AC_THERMOSTAT_ID).trim()
        });
      } catch (error) {
        warnings.push(`AC fan off failed: ${error.message || "Ecobee request failed."}`);
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
