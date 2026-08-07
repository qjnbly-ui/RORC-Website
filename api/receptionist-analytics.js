const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };

function bearerToken(req) {
  const match = String(req.headers?.authorization || req.headers?.Authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function request(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(String(data?.message || data?.error || `Request failed (${response.status}).`));
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

function serviceHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
}

async function requireAccountManager(token, fetcher = fetch) {
  if (!token) {
    const error = new Error("Missing session token");
    error.statusCode = 401;
    throw error;
  }
  const user = await request(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } }, fetcher);
  const rows = await request(`${SUPABASE_URL}/rest/v1/account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(user.id)}&limit=1`, { headers: serviceHeaders() }, fetcher);
  if (rows?.[0]?.account_type !== "Account Manager") {
    const error = new Error("Only account managers can view receptionist analytics.");
    error.statusCode = 403;
    throw error;
  }
  return rows[0];
}

function percentile(values, amount) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * amount) - 1))];
}

function countBy(rows, field) {
  return rows.reduce((counts, row) => {
    const key = String(row?.[field] || "unknown");
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function aggregateAnalytics(calls, events) {
  const routed = events.filter((event) => event.event_type === "intent_routed");
  const routeLatencies = routed.map((event) => Number(event.latency_ms)).filter(Number.isFinite);
  const answerLatencies = events.filter((event) => event.event_type === "answer_generated").map((event) => Number(event.latency_ms)).filter(Number.isFinite);
  const errors = events.filter((event) => event.success === false);
  const activity = {
    accountChecks: events.filter((event) => ["pin_verified", "account_check"].includes(event.event_type)).length,
    formsStarted: events.filter((event) => event.event_type === "form_started").length,
    formsSent: events.filter((event) => ["form_link_sent", "form_draft_sent"].includes(event.event_type)).length,
    textsSent: events.filter((event) => event.event_type === "sms_sent").length,
    transfers: events.filter((event) => event.event_type === "transfer_requested").length,
    smsFailures: events.filter((event) => event.twilio_message_sid && event.success === false).length,
    routerFallbacks: routed.filter((event) => event.metadata?.source === "fallback").length,
    lowConfidence: routed.filter((event) => Number(event.confidence) < 0.65).length,
  };
  const recentIssues = events
    .filter((event) => event.utterance_text && (event.success === false || Number(event.confidence) < 0.65 || event.metadata?.source === "fallback"))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 50)
    .map((event) => ({
      at: event.created_at,
      wording: event.utterance_text,
      intent: event.intent || "",
      confidence: event.confidence === null ? null : Number(event.confidence),
      source: event.metadata?.source || "",
      errorCode: event.error_code || "",
    }));
  return {
    summary: {
      calls: calls.length,
      completedCalls: calls.filter((call) => call.ended_at).length,
      completionRate: calls.length ? Math.round((calls.filter((call) => call.ended_at).length / calls.length) * 1000) / 10 : 0,
      recognizedCallers: calls.filter((call) => call.caller_recognized).length,
      verifiedAccounts: calls.filter((call) => call.account_verified).length,
    },
    intents: countBy(routed, "intent"),
    outcomes: countBy(calls, "final_outcome"),
    latency: {
      routeAverageMs: routeLatencies.length ? Math.round(routeLatencies.reduce((sum, value) => sum + value, 0) / routeLatencies.length) : 0,
      routeP95Ms: percentile(routeLatencies, 0.95),
      answerAverageMs: answerLatencies.length ? Math.round(answerLatencies.reduce((sum, value) => sum + value, 0) / answerLatencies.length) : 0,
      answerP95Ms: percentile(answerLatencies, 0.95),
    },
    activity,
    errorCounts: countBy(errors, "error_code"),
    recentIssues,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
  if (!SERVICE_KEY) return res.status(500).json({ success: false, error: "Supabase service access is not configured" });
  try {
    await requireAccountManager(bearerToken(req));
    const range = Object.prototype.hasOwnProperty.call(RANGE_DAYS, req.query?.range) ? req.query.range : "30d";
    const since = new Date(Date.now() - RANGE_DAYS[range] * 86400000).toISOString();
    const [calls, events] = await Promise.all([
      request(`${SUPABASE_URL}/rest/v1/rorc_receptionist_calls?select=call_sid,caller_recognized,account_verified,knowledge_version,final_outcome,started_at,ended_at&started_at=gte.${encodeURIComponent(since)}&order=started_at.desc&limit=5000`, { headers: serviceHeaders() }),
      request(`${SUPABASE_URL}/rest/v1/rorc_receptionist_events?select=event_type,intent,confidence,latency_ms,success,error_code,utterance_text,twilio_message_sid,metadata,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=5000`, { headers: serviceHeaders() }),
    ]);
    return res.status(200).json({ success: true, range, generatedAt: new Date().toISOString(), ...aggregateAnalytics(calls || [], events || []) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Could not load receptionist analytics." });
  }
};

module.exports.aggregateAnalytics = aggregateAnalytics;
module.exports.bearerToken = bearerToken;
module.exports.percentile = percentile;
module.exports.requireAccountManager = requireAccountManager;
