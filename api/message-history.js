const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token" });
    }

    const user = await getSupabaseUser(token);
    const manager = await getAccountMemberByAuthUserId(user.id);
    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Only account managers can load message history." });
    }

    const rows = await supabaseRest(
      "member_notifications?select=id,title,message,channels,created_at,recipient_member_id,created_by_member_id&created_by_member_id=not.is.null&order=created_at.desc&limit=1000"
    );

    return res.status(200).json({
      success: true,
      history: aggregateMessageHistory(rows || [])
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
};

function aggregateMessageHistory(rows) {
  const groups = new Map();

  rows.forEach((row) => {
    const channels = row.channels || {};
    const isHistoryRecord = Boolean(channels.dispatchHistory);
    const isLegacyInApp = Boolean(channels.inApp || channels.browser);

    if (!isHistoryRecord && !isLegacyInApp) return;

    const key = channels.dispatchId
      || [
        "legacy",
        row.created_by_member_id || "",
        row.created_at || "",
        row.title || "",
        row.message || ""
      ].join("|");

    if (!groups.has(key)) {
      const isScheduledPlaceholder = Boolean(channels.scheduled);
      groups.set(key, {
        id: key,
        title: row.title || "Message",
        message: row.message || "",
        channels: {
          text: Boolean(channels.text),
          email: Boolean(channels.email),
          inApp: Boolean(channels.inApp || channels.browser),
          scheduled: isScheduledPlaceholder,
          scheduledFor: channels.scheduledFor || "",
          scheduleLabel: channels.scheduleLabel || "",
          rentalRequestId: channels.rentalRequestId || "",
          source: channels.source || ""
        },
        hasDeliveryRecord: isHistoryRecord && !isScheduledPlaceholder,
        recipientMemberIds: new Set(),
        recipientCount: Number(channels.recipientCount || 0) || 0,
        sentTextCount: Number(channels.sentTextCount || 0) || 0,
        sentEmailCount: Number(channels.sentEmailCount || 0) || 0,
        sentInAppCount: Number(channels.sentInAppCount || 0) || 0,
        warnings: Array.isArray(channels.errorMessages) ? channels.errorMessages : [],
        createdAt: row.created_at || new Date().toISOString()
      });
    }

    const group = groups.get(key);
    if (row.recipient_member_id) {
      group.recipientMemberIds.add(row.recipient_member_id);
    }
    if (new Date(row.created_at) > new Date(group.createdAt)) {
      group.createdAt = row.created_at;
    }
    if (isHistoryRecord && !channels.scheduled) {
      group.hasDeliveryRecord = true;
      group.channels.scheduled = false;
      group.recipientCount = Number(channels.recipientCount || group.recipientCount || 0) || 0;
      group.sentTextCount = Number(channels.sentTextCount || group.sentTextCount || 0) || 0;
      group.sentEmailCount = Number(channels.sentEmailCount || group.sentEmailCount || 0) || 0;
      group.sentInAppCount = Number(channels.sentInAppCount || group.sentInAppCount || 0) || 0;
      group.warnings = Array.isArray(channels.errorMessages) ? channels.errorMessages : group.warnings;
    } else if (channels.scheduled && !group.hasDeliveryRecord) {
      group.channels.scheduled = true;
      group.channels.scheduledFor = channels.scheduledFor || group.channels.scheduledFor || "";
      group.channels.scheduleLabel = channels.scheduleLabel || group.channels.scheduleLabel || "";
    }
  });

  return [...groups.values()]
    .map((group) => {
      const recipientCount = group.recipientCount || group.recipientMemberIds.size;
      const sentInAppCount = group.sentInAppCount || (group.channels.inApp ? group.recipientMemberIds.size : 0);

      return {
        id: group.id,
        title: group.title,
        message: group.message,
        channels: group.channels,
        recipientCount,
        sentTextCount: group.sentTextCount,
        sentEmailCount: group.sentEmailCount,
        sentInAppCount,
        warnings: group.warnings,
        createdAt: group.createdAt
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 200);
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
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
