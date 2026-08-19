const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const GYM_OFF_TO_NUMBER = "+15418916772";
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const { resumeEcobeeProgram } = require("./_ecobee-client");
const { hasActiveThermostatRuntime } = require("./_thermostat-runtime-state");
const { parseSmsDestinations } = require("./_sms-destinations");
const ECOBEE_AC_THERMOSTAT_ID = process.env.ECOBEE_AC_THERMOSTAT_ID || "";
const { requireCronAuthorization } = require("./_automation-security");
const { runAutomationStep } = require("./_automation-step");
const { announceVoiceMonkey, triggerVoiceMonkey } = require("./_voice-monkey");

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
    const visitDurationMinutes = Number(req.body?.visitDurationMinutes || 0);
    const settings = await getAutomationConfig("gym_lights_off");
    if (settings.enabled === false) {
      return res.status(200).json({ success: true, skipped: true });
    }
    const warnings = [];
    let fanAutomationSkipped = "";

    if (settings.step1_enabled !== false && !completedSteps.has("announcement")) {
      await runAutomationStep({ req, completedSteps, step: "announcement", action: async () => {
        await announceVoiceMonkey({
          v3Device: settings.step1_v3_device,
          v3EnvironmentName: "GYM_LIGHTS_OFF_ANNOUNCEMENT_DEVICE",
          speech: settings.step1_speech,
          voice: settings.step1_voice,
          chime: settings.step1_chime,
          characterDisplay: settings.step1_character_display,
          label: "Gym closing announcement"
        });
      }});
    }

    if (settings.step2_enabled !== false && !completedSteps.has("lights")) {
      await runAutomationStep({ req, completedSteps, step: "lights", action: async () => {
        await triggerVoiceMonkey({
          v3Device: settings.step2_v3_device,
          v3EnvironmentName: "GYM_LIGHTS_OFF_TRIGGER_DEVICE",
          label: "Gym closing trigger"
        });
      }});
    }

    if (settings.sms_enabled !== false && !completedSteps.has("sms")) {
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        throw new Error("Step 3 failed: Twilio credentials are not configured.");
      }

      const smsDestinations = parseSmsDestinations(settings.sms_to, GYM_OFF_TO_NUMBER);
      const smsBody = `GYM LIGHTS OFF\nMember Last To Exit: ${memberName}\nVisit Duration: ${Math.max(0, Math.round(visitDurationMinutes))} MIN`;
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
          warnings.push(`AC fan off skipped: ${error.message || "Could not verify AC runtime."}`);
        }

        if (acRuntimeActive) {
          fanAutomationSkipped = "active_ac";
        } else if (acRuntimeActive === false) {
          try {
            await resumeEcobeeProgram({
              thermostatId: String(settings.ac_thermostat_id || ECOBEE_AC_THERMOSTAT_ID).trim()
            });
          } catch (error) {
            warnings.push(`AC fan off failed: ${error.message || "Ecobee request failed."}`);
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
