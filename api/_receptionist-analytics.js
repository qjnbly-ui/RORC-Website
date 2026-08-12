const crypto = require("crypto");
const { normalizePhone } = require("./_rorc-sms");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SECURITY_SECRET = String(process.env.RORC_RECEPTIONIST_SECURITY_SECRET || "").trim();
const INTENTS = new Set([
  "simple_question", "detailed_explanation", "send_information",
  "start_form", "check_account", "request_person",
]);

function hashCaller(phone, secret = SECURITY_SECRET) {
  const normalized = normalizePhone(phone);
  if (!secret || !normalized) return "";
  return crypto.createHmac("sha256", secret).update(normalized).digest("hex");
}

function callerKey(phone) {
  return hashCaller(phone);
}

function configured() {
  return Boolean(SERVICE_KEY && SECURITY_SECRET);
}

function headers(prefer = "") {
  const value = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) value.Prefer = prefer;
  return value;
}

async function rest(path, options = {}) {
  if (!SERVICE_KEY) throw new Error("Supabase service access is not configured.");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(String(data?.message || data?.error || `Receptionist data request failed (${response.status}).`));
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(Object.entries(metadata).slice(0, 20).map(([key, value]) => {
    if (typeof value === "boolean" || typeof value === "number" || value === null) return [String(key).slice(0, 80), value];
    return [String(key).slice(0, 80), String(value).slice(0, 500)];
  }));
}

function errorCode(error) {
  const providerCode = String(error?.code || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const status = Number(error?.status || error?.statusCode || 0);
  return providerCode || (status ? `http_${status}` : "internal_error");
}

async function startCall({
  callSid,
  phone,
  recognized = false,
  knowledgeVersion = "",
  promptVersion = "",
  routerModel = "",
  answerModel = "",
}) {
  const key = callerKey(phone);
  if (!configured() || !callSid || !key) return null;
  await rest("rorc_receptionist_calls?on_conflict=call_sid", {
    method: "POST",
    headers: headers("resolution=merge-duplicates,return=minimal"),
    body: JSON.stringify({
      call_sid: String(callSid).slice(0, 80),
      caller_key: key,
      caller_recognized: Boolean(recognized),
      knowledge_version: String(knowledgeVersion || "").slice(0, 80) || null,
      prompt_version: String(promptVersion || "").slice(0, 80) || null,
      router_model: String(routerModel || "").slice(0, 120) || null,
      answer_model: String(answerModel || "").slice(0, 120) || null,
      started_at: new Date().toISOString(),
    }),
  });
  return key;
}

async function recordReviewItem(callSid, item = {}) {
  if (!SERVICE_KEY || !callSid) return null;
  const reasons = [...new Set((Array.isArray(item.reasons) ? item.reasons : [])
    .map((value) => String(value || "").slice(0, 80))
    .filter(Boolean))];
  const utterance = String(item.utterance || "").trim().slice(0, 800);
  const response = String(item.response || "").trim().slice(0, 2400);
  if (!reasons.length || !utterance || !response) return null;
  const rows = await rest("rorc_receptionist_review_items", {
    method: "POST",
    headers: headers("return=representation"),
    body: JSON.stringify({
      call_sid: String(callSid).slice(0, 80),
      caller_utterance: utterance,
      assistant_response: response,
      review_reasons: reasons,
      intent: INTENTS.has(item.intent) ? item.intent : null,
      confidence: Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : null,
      route_source: ["model", "fallback"].includes(item.routeSource) ? item.routeSource : null,
      knowledge_version: String(item.knowledgeVersion || "").slice(0, 80) || null,
      prompt_version: String(item.promptVersion || "").slice(0, 80) || null,
      router_model: String(item.routerModel || "").slice(0, 120) || null,
      answer_model: String(item.answerModel || "").slice(0, 120) || null,
    }),
  });
  return rows?.[0] || null;
}

async function updateCall(callSid, patch = {}) {
  if (!SERVICE_KEY || !callSid) return;
  const allowed = {};
  if (Object.prototype.hasOwnProperty.call(patch, "recognized")) allowed.caller_recognized = Boolean(patch.recognized);
  if (Object.prototype.hasOwnProperty.call(patch, "verified")) allowed.account_verified = Boolean(patch.verified);
  if (Object.prototype.hasOwnProperty.call(patch, "outcome")) allowed.final_outcome = String(patch.outcome || "").slice(0, 80) || null;
  if (Object.prototype.hasOwnProperty.call(patch, "ended")) allowed.ended_at = patch.ended ? new Date().toISOString() : null;
  if (!Object.keys(allowed).length) return;
  await rest(`rorc_receptionist_calls?call_sid=eq.${encodeURIComponent(callSid)}`, {
    method: "PATCH",
    headers: headers("return=minimal"),
    body: JSON.stringify(allowed),
  });
}

async function recordEvent(callSid, event = {}) {
  if (!SERVICE_KEY || !callSid) return null;
  const utterance = String(event.utterance || "").slice(0, 800) || null;
  const rows = await rest("rorc_receptionist_events", {
    method: "POST",
    headers: headers("return=representation"),
    body: JSON.stringify({
      call_sid: String(callSid).slice(0, 80),
      event_type: String(event.type || "unknown").slice(0, 80),
      intent: INTENTS.has(event.intent) ? event.intent : null,
      confidence: Number.isFinite(event.confidence) ? Math.max(0, Math.min(1, event.confidence)) : null,
      latency_ms: Number.isFinite(event.latencyMs) ? Math.max(0, Math.round(event.latencyMs)) : null,
      success: event.success !== false,
      error_code: event.error ? errorCode(event.error) : (String(event.errorCode || "").slice(0, 80) || null),
      utterance_text: utterance,
      utterance_expires_at: utterance ? new Date(Date.now() + 7 * 86400000).toISOString() : null,
      twilio_message_sid: String(event.messageSid || "").slice(0, 80) || null,
      metadata: safeMetadata(event.metadata),
    }),
  });
  return rows?.[0] || null;
}

async function updateMessageStatus(messageSid, status, error = {}) {
  if (!SERVICE_KEY || !messageSid) return;
  const rows = await rest(`rorc_receptionist_events?twilio_message_sid=eq.${encodeURIComponent(messageSid)}&order=created_at.desc&limit=1`, {
    headers: { ...headers(), Prefer: "return=representation" },
  });
  const row = rows?.[0];
  if (!row) return;
  const metadata = { ...(row.metadata || {}), deliveryStatus: String(status || "unknown").slice(0, 80) };
  if (error.code) metadata.deliveryErrorCode = String(error.code).slice(0, 80);
  await rest(`rorc_receptionist_events?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: headers("return=minimal"),
    body: JSON.stringify({
      success: !["failed", "undelivered"].includes(String(status || "").toLowerCase()),
      error_code: error.code ? `twilio_${String(error.code).replace(/[^0-9A-Za-z_-]/g, "").slice(0, 60)}` : null,
      metadata,
    }),
  });
}

async function pinStatus(key) {
  if (!SERVICE_KEY || !key) return { failedAttempts: 0, lockedUntil: null, isLocked: false };
  const rows = await rest(`rorc_receptionist_pin_lockouts?select=failed_attempts,locked_until&caller_key=eq.${encodeURIComponent(key)}&limit=1`);
  const row = rows?.[0];
  const lockedUntil = row?.locked_until || null;
  return {
    failedAttempts: Number(row?.failed_attempts || 0),
    lockedUntil,
    isLocked: Boolean(lockedUntil && new Date(lockedUntil).getTime() > Date.now()),
  };
}

async function recordPinAttempt(key, succeeded) {
  if (!SERVICE_KEY || !key) throw new Error("Persistent PIN security is not configured.");
  const rows = await rest("rpc/rorc_receptionist_record_pin_attempt", {
    method: "POST",
    headers: headers("return=representation"),
    body: JSON.stringify({ p_caller_key: key, p_succeeded: Boolean(succeeded) }),
  });
  const row = rows?.[0] || {};
  return {
    failedAttempts: Number(row.failed_attempts || 0),
    lockedUntil: row.locked_until || null,
    isLocked: Boolean(row.is_locked),
  };
}

module.exports = {
  callerKey,
  configured,
  errorCode,
  hashCaller,
  pinStatus,
  recordEvent,
  recordPinAttempt,
  recordReviewItem,
  rest,
  safeMetadata,
  startCall,
  updateCall,
  updateMessageStatus,
};
