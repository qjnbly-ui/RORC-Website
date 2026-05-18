const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== "GET") {
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
    const currentMember = await getAccountMemberByAuthUserId(user.id);
    const role = String(currentMember?.account_type || "");

    if (!["Account Manager", "Kiosk Account"].includes(role)) {
      return res.status(403).json({ success: false, error: "Only account managers and kiosk accounts can load full directory." });
    }

    const rows = await supabaseRest(
      "account_member_profiles?select=account_member_id,account_id,account_number,member_name,account_type,phone_number,email_address,allow_guest_entry,allow_heater_use,is_billing_owner&order=account_number.asc&order=member_name.asc"
    );

    return res.status(200).json({ success: true, members: rows || [] });
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
  const rows = await supabaseRest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
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
