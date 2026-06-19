const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FACILITY_TIME_ZONE = "America/Los_Angeles";
const DOOR_ACTIONS = {
  unlock: {
    label: "Unlock Door",
    url: "https://door.n3xra.co/unlock"
  },
  lock: {
    label: "Lock Door",
    url: "https://door.n3xra.co/lock"
  },
  remain_unlocked: {
    label: "Remain Unlocked",
    url: "https://door.n3xra.co/remain_unlocked"
  },
  remain_locked: {
    label: "Remain Locked",
    url: "https://door.n3xra.co/remain_locked"
  }
};

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

    const source = sanitizeSource(req.body?.source);
    const action = sanitizeDoorAction(req.body?.action);
    if (!canUseDoorAction(member, action)) {
      return res.status(403).json({ success: false, error: "This door action is not available for this account." });
    }

    let requestStatus = "sent";
    let doorError = "";

    try {
      await sendDoorAction(action);
    } catch (error) {
      requestStatus = "failed";
      doorError = error.message || "Door controller request failed.";
    }

    const rows = await supabaseWrite("door_access_entries", "POST", {
      requested_by_member_id: member.id,
      access_requested_at: new Date().toISOString(),
      request_status: requestStatus,
      request_source: source,
      note: doorError
        ? `${DOOR_ACTIONS[action].label} requested from RORC app. ${doorError}`
        : `${DOOR_ACTIONS[action].label} requested from RORC app.`
    });

    if (requestStatus === "failed") {
      return res.status(502).json({ success: false, error: doorError, entry: rows[0] || null });
    }

    return res.status(200).json({ success: true, action, entry: rows[0] || null });
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

function canUseDoorAction(member, action, now = new Date()) {
  const accountType = String(member?.account_type || "").trim();
  if (accountType === "Account Manager") {
    return true;
  }
  if (accountType === "Special Access Account") {
    return action !== "remain_locked";
  }
  return action === "unlock" && canUseDoorAccess(member, now);
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

function sanitizeDoorAction(value) {
  const action = String(value || "unlock").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DOOR_ACTIONS, action)) return action;
  throw httpError(400, "Invalid door action.");
}

async function sendDoorAction(action) {
  const response = await fetch(DOOR_ACTIONS[action].url, {
    method: "GET",
    cache: "no-store"
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || body?.success === false) {
    const message = body?.message || body?.error || `Door controller returned ${response.status}.`;
    throw new Error(message);
  }
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
