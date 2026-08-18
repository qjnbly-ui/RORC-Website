const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SETTINGS_ID = "gym_lights_manual_mode";
const { requireFacilityOperator, resolveVoiceMonkeyUrl } = require("./_automation-security");

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Supabase service role key is not configured" });
  }

  try {
    const operator = await requireFacilityOperator(req);

    if (req.method === "GET") {
      const config = await getAutomationConfig(SETTINGS_ID);
      return res.status(200).json({
        success: true,
        settings: {
          mode: config.mode === "half" ? "half" : "full"
        }
      });
    }

    if (req.method === "POST") {
      const requestedMode = String(req.body?.mode || "").trim().toLowerCase();
      const mode = requestedMode === "half" ? "half" : requestedMode === "full" ? "full" : "";
      if (!mode) {
        return res.status(400).json({ success: false, error: "mode must be 'full' or 'half'." });
      }

      const settings = await getAutomationConfig("gym_lights_on");
      const fullLightsUrl = resolveVoiceMonkeyUrl({ settingValue: settings.step2_url, environmentName: "GYM_LIGHTS_ON_FULL_URL", label: "Full-lights control URL" });
      const halfLightsOffUrl = resolveVoiceMonkeyUrl({ settingValue: settings.manual_half_lights_off_url, environmentName: "GYM_LIGHTS_MANUAL_HALF_OFF_URL", label: "Manual half-lights control URL" });
      const targetUrl = mode === "half" ? halfLightsOffUrl : fullLightsUrl;

      const triggerResponse = await fetch(targetUrl, { method: "GET" });
      if (!triggerResponse.ok) {
        const text = await triggerResponse.text();
        throw new Error(`Lights trigger failed: ${triggerResponse.status} ${text}`);
      }

      await saveAutomationConfig(SETTINGS_ID, {
        mode,
        updated_at: new Date().toISOString(),
        updated_by: operator.id
      });

      return res.status(200).json({
        success: true,
        settings: { mode }
      });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Server error" });
  }
};

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

async function saveAutomationConfig(id, config) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/automation_settings`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify([{ id, config }])
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not save light mode state: ${response.status} ${text}`);
  }
}
