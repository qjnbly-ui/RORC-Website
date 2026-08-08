const twilio = require("twilio");
const { publicHttpUrl } = require("./_receptionist");
const { normalizePhone } = require("./_rorc-sms");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
const RORC_PHONE = normalizePhone(process.env.TWILIO_FROM_NUMBER || process.env.RORC_RECEPTIONIST_NUMBER || "+15416526065");

function bearerToken(req) {
  const match = String(req.headers?.authorization || req.headers?.Authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function httpError(statusCode, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

async function requestJson(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = String(data?.message || data?.error || data?.hint || `Request failed (${response.status}).`);
    if (/staff_communication_|record_staff_communication_message/i.test(detail)) {
      throw httpError(503, "The staff communications database has not been installed yet.");
    }
    throw httpError(response.status, detail);
  }
  return data;
}

function serviceHeaders(extra = {}) {
  if (!SERVICE_KEY) throw httpError(500, "Supabase service access is not configured.");
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    ...extra
  };
}

async function requireAccountManager(req, fetcher = fetch) {
  const token = bearerToken(req);
  if (!token) throw httpError(401, "Missing session token.");
  const user = await requestJson(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  }, fetcher).catch((error) => {
    if (error.statusCode === 401 || error.statusCode === 403) throw httpError(401, "Invalid session.");
    throw error;
  });
  const rows = await requestJson(
    `${SUPABASE_URL}/rest/v1/account_members?select=id,member_name,account_type&auth_user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
    { headers: serviceHeaders() },
    fetcher
  );
  const manager = rows?.[0];
  if (!manager || manager.account_type !== "Account Manager") {
    throw httpError(403, "Only account managers can use calls and messages.");
  }
  return manager;
}

async function serviceRest(path, options = {}, fetcher = fetch) {
  return requestJson(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: serviceHeaders(options.headers || {})
  }, fetcher);
}

function parseInboundMedia(payload = {}) {
  const count = Math.max(0, Math.min(10, Number(payload.NumMedia || 0) || 0));
  return Array.from({ length: count }, (_, index) => ({
    url: String(payload[`MediaUrl${index}`] || "").trim(),
    contentType: String(payload[`MediaContentType${index}`] || "application/octet-stream").trim()
  })).filter((item) => item.url);
}

async function recordCommunicationMessage({
  phone,
  messageSid,
  direction,
  body,
  status,
  from,
  to,
  media = [],
  createdByMemberId = null,
  messageAt = new Date().toISOString()
}, fetcher = fetch) {
  const phoneE164 = normalizePhone(phone);
  const fromE164 = normalizePhone(from);
  const toE164 = normalizePhone(to);
  if (!phoneE164 || !fromE164 || !toE164) throw httpError(400, "A valid phone number is required.");
  if (!String(messageSid || "").trim()) throw httpError(400, "A Twilio message SID is required.");
  const rows = await serviceRest("rpc/record_staff_communication_message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      p_phone_e164: phoneE164,
      p_twilio_message_sid: String(messageSid).trim(),
      p_direction: direction,
      p_body: String(body || "").slice(0, 16000),
      p_message_status: String(status || (direction === "inbound" ? "received" : "queued")).toLowerCase(),
      p_from_e164: fromE164,
      p_to_e164: toE164,
      p_media: Array.isArray(media) ? media : [],
      p_created_by_member_id: createdByMemberId || null,
      p_message_at: messageAt
    })
  }, fetcher);
  return rows?.[0] || null;
}

async function recordIncomingMessage(payload, fetcher = fetch) {
  const from = normalizePhone(payload?.From);
  const to = normalizePhone(payload?.To || RORC_PHONE);
  const messageSid = String(payload?.MessageSid || payload?.SmsMessageSid || "").trim();
  if (!from || !to || !messageSid) throw httpError(400, "The incoming message payload is incomplete.");
  return recordCommunicationMessage({
    phone: from,
    messageSid,
    direction: "inbound",
    body: payload?.Body,
    status: "received",
    from,
    to,
    media: parseInboundMedia(payload)
  }, fetcher);
}

async function listThreads(fetcher = fetch) {
  const [threads, members] = await Promise.all([
    serviceRest(
      "staff_communication_threads?select=id,phone_e164,unread_count,last_message_preview,last_message_direction,last_message_at,created_at,updated_at&order=last_message_at.desc&limit=500",
      {},
      fetcher
    ),
    serviceRest(
      "account_members?select=id,member_name,phone_number&phone_number=not.is.null&limit=5000",
      {},
      fetcher
    )
  ]);
  const memberByPhone = new Map();
  (members || []).forEach((member) => {
    const phone = normalizePhone(member.phone_number);
    if (phone && !memberByPhone.has(phone)) memberByPhone.set(phone, member);
  });
  return (threads || []).map((thread) => {
    const member = memberByPhone.get(thread.phone_e164);
    return {
      id: thread.id,
      phone: thread.phone_e164,
      unreadCount: Number(thread.unread_count || 0),
      preview: thread.last_message_preview || "",
      direction: thread.last_message_direction || "",
      lastMessageAt: thread.last_message_at,
      contact: member ? { id: member.id, name: member.member_name || "" } : null
    };
  });
}

async function listMessages(threadId, fetcher = fetch) {
  const cleanThreadId = String(threadId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(cleanThreadId)) throw httpError(400, "A valid conversation is required.");
  const rows = await serviceRest(
    `staff_communication_messages?select=id,thread_id,twilio_message_sid,direction,body,message_status,from_e164,to_e164,media_count,media,error_code,message_at,status_updated_at&thread_id=eq.${encodeURIComponent(cleanThreadId)}&order=message_at.asc&limit=1000`,
    {},
    fetcher
  );
  return (rows || []).map((message) => ({
    id: message.id,
    threadId: message.thread_id,
    sid: message.twilio_message_sid,
    direction: message.direction,
    body: message.body || "",
    status: message.message_status,
    from: message.from_e164,
    to: message.to_e164,
    mediaCount: Number(message.media_count || 0),
    media: Array.isArray(message.media) ? message.media : [],
    errorCode: message.error_code || "",
    messageAt: message.message_at,
    statusUpdatedAt: message.status_updated_at
  }));
}

async function markThreadRead(threadId, fetcher = fetch) {
  const cleanThreadId = String(threadId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(cleanThreadId)) throw httpError(400, "A valid conversation is required.");
  await serviceRest(`staff_communication_threads?id=eq.${encodeURIComponent(cleanThreadId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ unread_count: 0 })
  }, fetcher);
}

async function explicitSmsOptOut(phone, fetcher = fetch) {
  const phoneE164 = normalizePhone(phone);
  if (!phoneE164) return false;
  const rows = await serviceRest(
    `rorc_receptionist_sms_consent?select=consent_status&phone_e164=eq.${encodeURIComponent(phoneE164)}&limit=1`,
    {},
    fetcher
  ).catch((error) => {
    if (error.statusCode === 404) return [];
    throw error;
  });
  return rows?.[0]?.consent_status === "opt_out";
}

function communicationsUrl(req, path) {
  return new URL(path, publicHttpUrl(req)).toString();
}

async function sendStaffMessage({ to, body, managerId, req }, fetcher = fetch) {
  const recipient = normalizePhone(to);
  const messageBody = String(body || "").trim();
  if (!recipient) throw httpError(400, "Enter a valid phone number.");
  if (!messageBody) throw httpError(400, "Enter a message.");
  if (messageBody.length > 1600) throw httpError(400, "Messages can be up to 1,600 characters.");
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !RORC_PHONE) {
    throw httpError(503, "Twilio messaging is not configured.");
  }
  if (await explicitSmsOptOut(recipient, fetcher)) {
    throw httpError(409, "This number opted out of RORC texts. They must reply START before another text can be sent.");
  }
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  let sent;
  try {
    sent = await client.messages.create({
      from: RORC_PHONE,
      to: recipient,
      body: messageBody,
      statusCallback: communicationsUrl(req, "/api/communications-sms-status")
    });
  } catch (error) {
    const code = error?.code ? ` Twilio ${error.code}.` : "";
    throw httpError(Number(error?.status) || 502, `Twilio could not send this message.${code} ${error?.message || ""}`.trim());
  }
  const recorded = await recordCommunicationMessage({
    phone: recipient,
    messageSid: sent.sid,
    direction: "outbound",
    body: messageBody,
    status: String(sent.status || "queued").toLowerCase(),
    from: RORC_PHONE,
    to: recipient,
    createdByMemberId: managerId
  }, fetcher);
  return { sid: sent.sid, status: sent.status || "queued", ...recorded };
}

async function updateMessageStatus(messageSid, status, errorCode = "", fetcher = fetch) {
  const sid = String(messageSid || "").trim();
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const allowed = new Set([
    "accepted", "scheduled", "canceled", "queued", "sending", "sent",
    "delivered", "undelivered", "failed", "receiving", "received", "read"
  ]);
  if (!sid || !allowed.has(normalizedStatus)) return;
  await serviceRest(`staff_communication_messages?twilio_message_sid=eq.${encodeURIComponent(sid)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      message_status: normalizedStatus,
      error_code: String(errorCode || "").trim() || null,
      status_updated_at: new Date().toISOString()
    })
  }, fetcher);
}

module.exports = {
  RORC_PHONE,
  bearerToken,
  communicationsUrl,
  explicitSmsOptOut,
  httpError,
  listMessages,
  listThreads,
  markThreadRead,
  parseInboundMedia,
  recordCommunicationMessage,
  recordIncomingMessage,
  requireAccountManager,
  sendStaffMessage,
  updateMessageStatus
};
