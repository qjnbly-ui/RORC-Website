const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ECOBEE_CLIENT_ID = process.env.ECOBEE_CLIENT_ID || "";
const ECOBEE_ACCESS_TOKEN = process.env.ECOBEE_ACCESS_TOKEN || "";
const ECOBEE_REFRESH_TOKEN = process.env.ECOBEE_REFRESH_TOKEN || "";

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

    const settings = await getAutomationConfig("heater_off");
    if (settings.enabled === false) {
      return res.status(200).json({ success: true, skipped: true });
    }

    await setEcobeeMode("off");

    return res.status(200).json({ success: true });
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

async function setEcobeeMode(mode) {
  if (!ECOBEE_CLIENT_ID || !ECOBEE_ACCESS_TOKEN || !ECOBEE_REFRESH_TOKEN) {
    throw new Error("Ecobee credentials are not configured.");
  }

  let token = ECOBEE_ACCESS_TOKEN;
  let result = await postEcobeeMode(mode, token);

  if (result.ok) return;

  const bodyText = result.text || "";
  const expired = result.status === 401
    || bodyText.includes('"code":14')
    || bodyText.toLowerCase().includes("authentication token has expired");

  if (!expired) {
    throw new Error(`Ecobee request failed: ${result.status} ${bodyText}`);
  }

  const refreshed = await refreshEcobeeToken();
  token = refreshed.access_token;
  result = await postEcobeeMode(mode, token);

  if (!result.ok) {
    throw new Error(`Ecobee retry failed: ${result.status} ${result.text || ""}`);
  }
}

async function postEcobeeMode(mode, token) {
  const response = await fetch("https://api.ecobee.com/1/thermostat?format=json", {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      selection: {
        selectionType: "registered",
        selectionMatch: ""
      },
      thermostat: {
        settings: {
          hvacMode: mode
        }
      }
    })
  });

  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function refreshEcobeeToken() {
  const payload = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: ECOBEE_REFRESH_TOKEN,
    client_id: ECOBEE_CLIENT_ID
  });

  const response = await fetch("https://api.ecobee.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload.toString()
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Ecobee token refresh failed: ${response.status} ${text}`);
  }

  const body = JSON.parse(text || "{}");
  if (!body.access_token) {
    throw new Error("Ecobee token refresh did not return access_token.");
  }

  return body;
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
