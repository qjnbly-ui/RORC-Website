const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (!["GET", "PATCH", "DELETE"].includes(req.method)) {
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
      return res.status(403).json({ success: false, error: "Only account managers can manage message history." });
    }

    if (req.method === "PATCH") {
      return await handleScheduledMessageCancel(req, res);
    }

    if (req.method === "DELETE") {
      return await handleScheduledMessageDelete(req, res);
    }

    const [rows, scheduledRows] = await Promise.all([
      supabaseRest(
        "member_notifications?select=id,title,message,channels,created_at,recipient_member_id,created_by_member_id&created_by_member_id=not.is.null&order=created_at.desc&limit=1000"
      ),
      supabaseRest(
        "scheduled_member_messages?select=id,created_by_member_id,rental_request_id,title,message,member_ids,channels,scheduled_for,schedule_label,dispatch_id,status,sent_at,canceled_at,last_error,created_at,updated_at&order=created_at.desc&limit=500"
      )
    ]);

    return res.status(200).json({
      success: true,
      history: aggregateMessageHistory(rows || [], scheduledRows || [])
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
};

async function handleScheduledMessageCancel(req, res) {
  const message = await findScheduledMessage(getRequestId(req));
  if (!message) {
    return res.status(404).json({ success: false, error: "Scheduled message not found." });
  }

  if (message.status === "canceled") {
    return res.status(200).json({ success: true, scheduledMessage: normalizeScheduledMessageActionResult(message) });
  }

  if (message.status !== "scheduled") {
    return res.status(409).json({ success: false, error: "Only pending scheduled messages can be canceled." });
  }

  const canceledAt = new Date().toISOString();
  await updateScheduledMessage(message.id, {
    status: "canceled",
    canceled_at: canceledAt,
    last_error: null
  });
  await updateHistoryRowsForDispatch(message.dispatch_id, {
    scheduled: false,
    scheduledStatus: "canceled",
    canceledAt
  }).catch(() => {});

  return res.status(200).json({
    success: true,
    scheduledMessage: normalizeScheduledMessageActionResult({
      ...message,
      status: "canceled",
      canceled_at: canceledAt,
      last_error: null
    })
  });
}

async function handleScheduledMessageDelete(req, res) {
  const message = await findScheduledMessage(getRequestId(req));
  if (!message) {
    return res.status(404).json({ success: false, error: "Scheduled message not found." });
  }

  if (message.status === "processing") {
    return res.status(409).json({ success: false, error: "This message is already processing and cannot be deleted." });
  }

  if (message.status === "sent") {
    return res.status(409).json({ success: false, error: "Sent message history cannot be deleted here." });
  }

  await deleteHistoryRowsForDispatch(message.dispatch_id);
  await deleteScheduledMessage(message.id);

  return res.status(200).json({ success: true });
}

function aggregateMessageHistory(rows, scheduledRows = []) {
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
        dispatchId: channels.dispatchId || "",
        scheduledMessageId: channels.scheduledMessageId || "",
        scheduledStatus: channels.scheduledStatus || (isScheduledPlaceholder ? "scheduled" : ""),
        canceledAt: channels.canceledAt || "",
        sentAt: channels.sentAt || "",
        lastError: "",
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
      group.channels.scheduled = group.scheduledStatus === "canceled" || group.scheduledStatus === "failed";
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

  scheduledRows.forEach((row) => {
    const dispatchId = String(row.dispatch_id || row.id || "").trim();
    if (!dispatchId) return;

    if (!groups.has(dispatchId)) {
      groups.set(dispatchId, {
        id: dispatchId,
        dispatchId,
        scheduledMessageId: row.id || "",
        scheduledStatus: row.status || "scheduled",
        canceledAt: row.canceled_at || "",
        sentAt: row.sent_at || "",
        lastError: row.last_error || "",
        title: row.title || "Message",
        message: row.message || "",
        channels: {
          text: Boolean(row.channels?.text),
          email: Boolean(row.channels?.email),
          inApp: Boolean(row.channels?.inApp),
          scheduled: ["scheduled", "processing", "canceled", "failed"].includes(row.status),
          scheduledFor: row.scheduled_for || "",
          scheduleLabel: row.schedule_label || "",
          rentalRequestId: row.rental_request_id || "",
          source: row.rental_request_id ? "rental" : ""
        },
        hasDeliveryRecord: false,
        recipientMemberIds: new Set(),
        recipientCount: Array.isArray(row.member_ids) ? row.member_ids.length : 0,
        sentTextCount: 0,
        sentEmailCount: 0,
        sentInAppCount: 0,
        warnings: row.last_error ? [row.last_error] : [],
        createdAt: row.created_at || new Date().toISOString()
      });
      return;
    }

    const group = groups.get(dispatchId);
    group.dispatchId = dispatchId;
    group.scheduledMessageId = row.id || group.scheduledMessageId || "";
    group.scheduledStatus = row.status || group.scheduledStatus || "scheduled";
    group.canceledAt = row.canceled_at || group.canceledAt || "";
    group.sentAt = row.sent_at || group.sentAt || "";
    group.lastError = row.last_error || "";
    group.channels.text = Boolean(row.channels?.text);
    group.channels.email = Boolean(row.channels?.email);
    group.channels.inApp = Boolean(row.channels?.inApp);
    group.channels.scheduled = ["scheduled", "processing", "canceled", "failed"].includes(row.status);
    group.channels.scheduledFor = row.scheduled_for || group.channels.scheduledFor || "";
    group.channels.scheduleLabel = row.schedule_label || group.channels.scheduleLabel || "";
    group.channels.rentalRequestId = row.rental_request_id || group.channels.rentalRequestId || "";
    group.channels.source = row.rental_request_id ? "rental" : group.channels.source || "";
    group.recipientCount = group.recipientCount || (Array.isArray(row.member_ids) ? row.member_ids.length : 0);
    if (row.last_error) group.warnings = [row.last_error];
  });

  return [...groups.values()]
    .map((group) => {
      const recipientCount = group.recipientCount || group.recipientMemberIds.size;
      const sentInAppCount = group.sentInAppCount || (group.channels.inApp ? group.recipientMemberIds.size : 0);
      const scheduledStatus = String(group.scheduledStatus || "").trim();

      return {
        id: group.id,
        dispatchId: group.dispatchId || group.id,
        scheduledMessageId: group.scheduledMessageId || "",
        scheduledStatus,
        canceledAt: group.canceledAt || "",
        sentAt: group.sentAt || "",
        lastError: group.lastError || "",
        title: group.title,
        message: group.message,
        channels: group.channels,
        recipientCount,
        sentTextCount: group.sentTextCount,
        sentEmailCount: group.sentEmailCount,
        sentInAppCount,
        warnings: group.warnings,
        createdAt: group.createdAt,
        canCancelScheduled: Boolean(group.scheduledMessageId && scheduledStatus === "scheduled"),
        canDeleteScheduled: Boolean(group.scheduledMessageId && ["scheduled", "canceled", "failed"].includes(scheduledStatus))
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 200);
}

function getRequestId(req) {
  const bodyId = String(req.body?.id || req.body?.scheduledMessageId || "").trim();
  if (bodyId) return bodyId;
  try {
    const url = new URL(req.url || "", "http://localhost");
    return String(url.searchParams.get("id") || url.searchParams.get("scheduledMessageId") || "").trim();
  } catch {
    return "";
  }
}

async function findScheduledMessage(id) {
  const cleanId = String(id || "").trim().replace(/[^a-zA-Z0-9-]/g, "");
  if (!cleanId) return null;
  const rows = await supabaseRest(
    `scheduled_member_messages?select=*&or=(id.eq.${encodeURIComponent(cleanId)},dispatch_id.eq.${encodeURIComponent(cleanId)})&limit=1`
  );
  return rows[0] || null;
}

async function updateScheduledMessage(id, patch) {
  await supabaseRest(`scheduled_member_messages?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch
  });
}

async function deleteScheduledMessage(id) {
  await supabaseRest(`scheduled_member_messages?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

async function updateHistoryRowsForDispatch(dispatchId, channelPatch) {
  const rows = await loadHistoryRowsForDispatch(dispatchId);
  await Promise.all(rows.map((row) => supabaseRest(`member_notifications?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    body: {
      channels: {
        ...(row.channels || {}),
        ...channelPatch
      }
    }
  })));
}

async function deleteHistoryRowsForDispatch(dispatchId) {
  if (!dispatchId) return;
  const params = new URLSearchParams();
  params.set("channels->>dispatchId", `eq.${dispatchId}`);
  await supabaseRest(`member_notifications?${params.toString()}`, {
    method: "DELETE"
  });
}

async function loadHistoryRowsForDispatch(dispatchId) {
  if (!dispatchId) return [];
  const params = new URLSearchParams();
  params.set("select", "id,channels");
  params.set("channels->>dispatchId", `eq.${dispatchId}`);
  return supabaseRest(`member_notifications?${params.toString()}`);
}

function normalizeScheduledMessageActionResult(row) {
  return {
    id: row.id,
    dispatchId: row.dispatch_id || "",
    status: row.status || "",
    scheduledFor: row.scheduled_for || "",
    canceledAt: row.canceled_at || "",
    sentAt: row.sent_at || ""
  };
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

async function supabaseRest(path, options = {}) {
  const method = options.method || "GET";
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `REST request failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
