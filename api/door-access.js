const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FACILITY_TIME_ZONE = "America/Los_Angeles";

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
    const member = await getAccountMemberByAuthUserId(user.id);
    if (!member) {
      return res.status(403).json({ success: false, error: "No linked member profile found." });
    }

    if (!canUseDoorAccess(member)) {
      return res.status(403).json({ success: false, error: "Door access is not available for this account." });
    }

    const source = sanitizeSource(req.body?.source);
    const rows = await supabaseWrite("door_access_entries", "POST", {
      requested_by_member_id: member.id,
      access_requested_at: new Date().toISOString(),
      request_status: "sent",
      request_source: source,
      note: "Entrance unlock requested from RORC app."
    });

    return res.status(200).json({ success: true, entry: rows[0] || null });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Server error" });
  }
};

function canUseDoorAccess(member, now = new Date()) {
  const accountType = String(member?.account_type || "").trim();
  if (["Account Manager", "Special Access Account", "Active Membership", "Work Exchange Membership Program"].includes(accountType)) {
    return true;
  }
  if (accountType === "Open Gym Only") {
    return isOpenGymWindow(now);
  }
  return false;
}

function isOpenGymWindow(date) {
  const parts = facilityClockParts(date);
  const minutes = (parts.hour * 60) + parts.minute;
  const startsAt = (17 * 60) + 50;
  const endsAt = (20 * 60) + 10;
  return ["Tue", "Thu"].includes(parts.weekday) && minutes >= startsAt && minutes <= endsAt;
}

function facilityClockParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: value.weekday,
    hour: Number(value.hour),
    minute: Number(value.minute)
  };
}

function sanitizeSource(value) {
  const source = String(value || "app").trim().toLowerCase();
  return ["app", "admin", "kiosk"].includes(source) ? source : "app";
}

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
    throw httpError(401, "Invalid session");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
}

async function supabaseRest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: supabaseHeaders()
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `Supabase REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function supabaseWrite(path, method, payload) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: supabaseHeaders({ prefer: "return=representation" }),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `Could not save door access record: ${response.status} ${text}`);
  }

  return response.json();
}

function supabaseHeaders({ prefer = "" } = {}) {
  const headers = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
