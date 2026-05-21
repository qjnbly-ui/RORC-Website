const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Supabase service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing Supabase session" });
    }

    const requesterUser = await getSupabaseUser(token);
    const requesterMember = await getAccountMemberByAuthUserId(requesterUser.id);
    if (!requesterMember) {
      return res.status(403).json({ success: false, error: "Signed-in member profile is not linked." });
    }

    const memberId = String(req.body?.memberId || "").trim();
    if (!memberId) {
      return res.status(400).json({ success: false, error: "memberId is required." });
    }

    const targetMember = await getAccountMemberById(memberId);
    if (!targetMember) {
      return res.status(404).json({ success: false, error: "Member not found." });
    }

    const deletingSelf = requesterMember.id === targetMember.id;
    const requesterIsManager = requesterMember.account_type === "Account Manager";

    if (deletingSelf) {
      return res.status(403).json({
        success: false,
        error: "You cannot delete your own user account from the app. Ask another account manager to make that change."
      });
    }

    if (!requesterIsManager) {
      return res.status(403).json({
        success: false,
        error: "Only account managers can delete user accounts."
      });
    }

    await deleteRows("heater_use_group_members", `account_member_id=eq.${encodeURIComponent(targetMember.id)}`);
    await deleteRows("billing_line_items", `account_member_id=eq.${encodeURIComponent(targetMember.id)}`);
    await deleteRows("account_members", `id=eq.${encodeURIComponent(targetMember.id)}`);

    if (targetMember.auth_user_id) {
      await deleteAuthUser(targetMember.auth_user_id);
    }

    return res.status(200).json({
      success: true,
      deletedMemberId: targetMember.id,
      deletedAuthUserId: targetMember.auth_user_id || null
    });
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

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(
    `account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
  );
  return rows[0] || null;
}

async function getAccountMemberById(memberId) {
  const rows = await supabaseRest(
    `account_members?select=id,auth_user_id&id=eq.${encodeURIComponent(memberId)}&limit=1`
  );
  return rows[0] || null;
}

async function deleteRows(table, whereQuery) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${whereQuery}`, {
    method: "DELETE",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not delete ${table}: ${response.status} ${text}`);
  }
}

async function deleteAuthUser(userId) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not delete auth user: ${response.status} ${text}`);
  }
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
    throw new Error(`Supabase REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}
