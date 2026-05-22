const FULL_LIGHTS_URL = "https://api-v2.voicemonkey.io/trigger?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=all-lights-on";
const HALF_LIGHTS_OFF_URL = "https://api-v2.voicemonkey.io/trigger?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=turn-half-the-lights-off";
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SETTINGS_ID = "gym_lights_manual_mode";

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Supabase service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing Supabase session" });
    }

    const user = await getSupabaseUser(token);
    if (!user?.id) {
      return res.status(401).json({ success: false, error: "Invalid Supabase session" });
    }

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
      const fullLightsUrl = String(settings.step2_url || FULL_LIGHTS_URL).trim() || FULL_LIGHTS_URL;
      const halfLightsOffUrl = String(settings.manual_half_lights_off_url || HALF_LIGHTS_OFF_URL).trim() || HALF_LIGHTS_OFF_URL;
      const targetUrl = mode === "half" ? halfLightsOffUrl : fullLightsUrl;

      const triggerResponse = await fetch(targetUrl, { method: "GET" });
      if (!triggerResponse.ok) {
        const text = await triggerResponse.text();
        throw new Error(`Lights trigger failed: ${triggerResponse.status} ${text}`);
      }

      await saveAutomationConfig(SETTINGS_ID, {
        mode,
        updated_at: new Date().toISOString(),
        updated_by: user.id
      });

      return res.status(200).json({
        success: true,
        settings: { mode }
      });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
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
    throw new Error("Invalid Supabase session");
  }

  return response.json();
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
