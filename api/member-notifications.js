const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token" });
    }

    const user = await getSupabaseUser(token);
    const member = await getAccountMemberByAuthUserId(user.id);
    if (!member?.id || !member?.account_id) {
      return res.status(404).json({ success: false, error: "Member profile not found." });
    }

    const accountMemberIds = await getAccountMemberIds(member.account_id);

    if (req.method === "GET") {
      const idList = accountMemberIds.map((id) => `"${String(id).replaceAll('"', "")}"`).join(",");
      const rows = await supabaseRest(
        `member_notifications?select=id,title,message,channels,created_at,read_at,recipient_member_id,created_by_member_id&recipient_member_id=in.(${encodeURIComponent(idList)})&order=created_at.desc&limit=200`
      );
      return res.status(200).json({ success: true, notifications: rows || [] });
    }

    if (req.method === "POST") {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
      if (!ids.length) {
        return res.status(400).json({ success: false, error: "No notification IDs provided." });
      }

      const idList = ids.map((id) => `"${id.replaceAll('"', "")}"`).join(",");
      const accountScopedIdList = accountMemberIds.map((id) => `"${String(id).replaceAll('"', "")}"`).join(",");
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/member_notifications?recipient_member_id=in.(${encodeURIComponent(accountScopedIdList)})&recipient_member_id=eq.${encodeURIComponent(member.id)}&id=in.(${encodeURIComponent(idList)})`,
        {
          method: "PATCH",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ read_at: new Date().toISOString() })
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Could not update notifications: ${response.status} ${text}`);
      }

      return res.status(200).json({ success: true });
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
    throw new Error("Invalid session");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(`account_members?select=id,account_id&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
}

async function getAccountMemberIds(accountId) {
  const rows = await supabaseRest(`account_members?select=id&account_id=eq.${encodeURIComponent(accountId)}&limit=500`);
  return rows.map((row) => row.id).filter(Boolean);
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
