const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

    const memberId = String(req.body?.memberId || "").trim();
    const pin = String(req.body?.pin || "").trim();

    if (!memberId) {
      return res.status(400).json({ success: false, error: "Responsible member is required." });
    }
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ success: false, error: "Heater PIN must be exactly 4 digits." });
    }

    const user = await getSupabaseUser(token);
    const actor = await getAccountMemberByAuthUserId(user.id);
    if (!actor?.id) {
      return res.status(404).json({ success: false, error: "Member profile not found." });
    }

    const target = await getAccountMemberById(memberId);
    if (!target?.id) {
      return res.status(404).json({ success: false, error: "Responsible member not found." });
    }

    const actorRole = String(actor.account_type || "");
    const canCrossAccount = actorRole === "Account Manager" || actorRole === "Kiosk Account";
    if (!canCrossAccount && actor.account_id !== target.account_id) {
      return res.status(403).json({ success: false, error: "You cannot verify PINs for another account." });
    }

    const verified = await verifyAgainstAccountHeaterPin(target.account_id, pin);
    if (!verified) {
      return res.status(403).json({ success: false, error: "Heater PIN does not match the shared account PIN." });
    }

    return res.status(200).json({ success: true, verified: true });
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
  const rows = await supabaseRest(`account_members?select=id,account_id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
}

async function getAccountMemberById(memberId) {
  const rows = await supabaseRest(`account_members?select=id,account_id&id=eq.${encodeURIComponent(memberId)}&limit=1`);
  return rows[0] || null;
}

async function verifyAgainstAccountHeaterPin(accountId, pin) {
  const rows = await supabaseRest(`accounts?select=heater_pin&id=eq.${encodeURIComponent(accountId)}&limit=1`);
  const accountPin = String(rows[0]?.heater_pin || "").trim();
  return Boolean(accountPin && accountPin === pin);
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
