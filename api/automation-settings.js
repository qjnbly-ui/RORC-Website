const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    const manager = await getAccountMemberByAuthUserId(user.id);
    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Only account managers can access automation settings." });
    }

    if (req.method === "GET") {
      const rows = await supabaseRest("automation_settings?select=id,config");
      const settings = Object.fromEntries((rows || []).map((row) => [row.id, row.config || {}]));
      const permissionRows = await supabaseRest("account_type_permissions?select=account_type,can_sign_in,bypass_time_windows,allowed_days,allowed_start_time,allowed_end_time");
      settings.account_type_permissions = normalizePermissionRows(permissionRows || []);
      return res.status(200).json({ success: true, settings });
    }

    if (req.method === "POST") {
      const settings = req.body?.settings || {};
      const automationOnly = Object.fromEntries(
        Object.entries(settings).filter(([id]) => id !== "account_type_permissions")
      );
      const payload = Object.entries(automationOnly).map(([id, config]) => ({ id, config }));

      if (payload.length) {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/automation_settings`, {
          method: "POST",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates"
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Could not save settings: ${response.status} ${text}`);
        }
      }

      const permissionSettings = settings.account_type_permissions || {};
      const permissionPayload = Object.values(permissionSettings).map((row) => ({
        account_type: canonicalAccountType(row.accountType),
        can_sign_in: Boolean(row.canSignIn),
        bypass_time_windows: Boolean(row.bypassTimeWindows),
        allowed_days: Array.isArray(row.allowedDays) ? row.allowedDays.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6) : [],
        allowed_start_time: row.allowedStartTime || null,
        allowed_end_time: row.allowedEndTime || null
      }));

      if (permissionPayload.length) {
        const permissionResponse = await fetch(`${SUPABASE_URL}/rest/v1/account_type_permissions`, {
          method: "POST",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates"
          },
          body: JSON.stringify(permissionPayload)
        });

        if (!permissionResponse.ok) {
          const text = await permissionResponse.text();
          throw new Error(`Could not save account type permissions: ${permissionResponse.status} ${text}`);
        }
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
    throw new Error("Invalid Supabase session");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const params = new URLSearchParams({
    select: "id,account_type",
    auth_user_id: `eq.${authUserId}`,
    limit: "1"
  });

  const rows = await supabaseRest(`account_members?${params.toString()}`);
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
    throw new Error(`Supabase REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

function canonicalAccountType(accountType) {
  const normalized = String(accountType || "").trim().toLowerCase();
  if (!normalized) return "Active Membership";
  if (normalized === "account manager") return "Account Manager";
  if (normalized === "kiosk account") return "Kiosk Account";
  if (normalized === "active membership") return "Active Membership";
  if (normalized === "work exchange membership program") return "Work Exchange Membership Program";
  if (normalized === "weight room only") return "Weight Room Only";
  if (normalized === "open gym only") return "Open Gym Only";
  if (normalized === "special access account") return "Special Access Account";
  if (normalized === "restricted account") return "RESTRICTED ACCOUNT";
  if (normalized === "billed monthly") return "Special Access Account";
  if (normalized === "account past due no access allowed") return "RESTRICTED ACCOUNT";
  return String(accountType || "").trim() || "Active Membership";
}

function normalizePermissionRows(rows) {
  const base = {
    "Account Manager": { accountType: "Account Manager", canSignIn: true, bypassTimeWindows: true, allowedDays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: null, allowedEndTime: null },
    "Kiosk Account": { accountType: "Kiosk Account", canSignIn: true, bypassTimeWindows: true, allowedDays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: null, allowedEndTime: null },
    "Special Access Account": { accountType: "Special Access Account", canSignIn: true, bypassTimeWindows: true, allowedDays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: null, allowedEndTime: null },
    "Active Membership": { accountType: "Active Membership", canSignIn: true, bypassTimeWindows: false, allowedDays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: "06:50:00", allowedEndTime: "21:10:00" },
    "Work Exchange Membership Program": { accountType: "Work Exchange Membership Program", canSignIn: true, bypassTimeWindows: false, allowedDays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: "06:50:00", allowedEndTime: "21:10:00" },
    "Weight Room Only": { accountType: "Weight Room Only", canSignIn: true, bypassTimeWindows: false, allowedDays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: "06:50:00", allowedEndTime: "21:10:00" },
    "Open Gym Only": { accountType: "Open Gym Only", canSignIn: true, bypassTimeWindows: false, allowedDays: [2, 4], allowedStartTime: "17:50:00", allowedEndTime: "20:10:00" },
    "RESTRICTED ACCOUNT": { accountType: "RESTRICTED ACCOUNT", canSignIn: false, bypassTimeWindows: false, allowedDays: [], allowedStartTime: null, allowedEndTime: null }
  };

  rows.forEach((row) => {
    const type = canonicalAccountType(row.account_type);
    base[type] = {
      accountType: type,
      canSignIn: Boolean(row.can_sign_in),
      bypassTimeWindows: Boolean(row.bypass_time_windows),
      allowedDays: Array.isArray(row.allowed_days) ? row.allowed_days.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6) : [],
      allowedStartTime: row.allowed_start_time || null,
      allowedEndTime: row.allowed_end_time || null
    };
  });

  return base;
}
