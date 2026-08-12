const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const REVIEW_STATUSES = new Set(["pending", "dismissed", "corrected"]);
const ISSUE_CATEGORIES = new Set(["correct", "wrong_information", "wrong_action", "confusing", "unresolved", "other"]);
const EVAL_CATEGORIES = new Set(["wrong_information", "wrong_action", "confusing", "unresolved", "other"]);
const INTENTS = new Set([
  "simple_question", "detailed_explanation", "send_information",
  "start_form", "check_account", "request_person",
]);

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function bearerToken(req) {
  const match = String(req.headers?.authorization || req.headers?.Authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function serviceHeaders(extra = {}) {
  if (!SERVICE_KEY) throw httpError(500, "Supabase service access is not configured.");
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra };
}

async function requestJson(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw httpError(response.status, String(data?.message || data?.error || data?.hint || `Request failed (${response.status}).`));
  }
  return data;
}

async function requireAccountManager(req, fetcher = fetch) {
  const token = bearerToken(req);
  if (!token) throw httpError(401, "Missing session token.");
  const user = await requestJson(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  }, fetcher).catch((error) => {
    if (error.statusCode === 401 || error.statusCode === 403) throw httpError(401, "Invalid session.");
    throw error;
  });
  const rows = await requestJson(
    `${SUPABASE_URL}/rest/v1/account_members?select=id,member_name,account_type&auth_user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
    { headers: serviceHeaders() },
    fetcher,
  );
  const manager = rows?.[0];
  if (!manager || manager.account_type !== "Account Manager") {
    throw httpError(403, "Only account managers can review receptionist conversations.");
  }
  return manager;
}

async function serviceRest(path, options = {}, fetcher = fetch) {
  return requestJson(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: serviceHeaders(options.headers || {}),
  }, fetcher);
}

function cleanText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanTextList(value, maxItems = 12, maxLength = 160) {
  const source = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  return [...new Set(source.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function mapReview(row = {}) {
  return {
    id: row.id || "",
    callSid: row.call_sid || "",
    callerUtterance: row.caller_utterance || "",
    assistantResponse: row.assistant_response || "",
    reasons: Array.isArray(row.review_reasons) ? row.review_reasons : [],
    intent: row.intent || "",
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    routeSource: row.route_source || "",
    knowledgeVersion: row.knowledge_version || "",
    promptVersion: row.prompt_version || "",
    routerModel: row.router_model || "",
    answerModel: row.answer_model || "",
    status: row.review_status || "pending",
    issueCategory: row.issue_category || "",
    expectedBehavior: row.expected_behavior || "",
    reviewedAt: row.reviewed_at || "",
    expiresAt: row.expires_at || "",
    createdAt: row.created_at || "",
  };
}

function mapEvalCase(row = {}) {
  return {
    id: row.id || "",
    sourceReviewId: row.source_review_id || "",
    callerUtterance: row.caller_utterance || "",
    expectedBehavior: row.expected_behavior || "",
    expectedIntent: row.expected_intent || "",
    requiredPhrases: Array.isArray(row.required_phrases) ? row.required_phrases : [],
    forbiddenPhrases: Array.isArray(row.forbidden_phrases) ? row.forbidden_phrases : [],
    issueCategory: row.issue_category || "",
    enabled: row.enabled !== false,
    createdAt: row.created_at || "",
  };
}

async function loadReviewData(fetcher = fetch, now = new Date()) {
  const reviewSelect = [
    "id", "call_sid", "caller_utterance", "assistant_response", "review_reasons",
    "intent", "confidence", "route_source", "knowledge_version", "prompt_version",
    "router_model", "answer_model", "review_status", "issue_category",
    "expected_behavior", "reviewed_at", "expires_at", "created_at",
  ].join(",");
  const evalSelect = "id,enabled,created_at";
  const [reviews, evalCases] = await Promise.all([
    serviceRest(`rorc_receptionist_review_items?select=${reviewSelect}&expires_at=gt.${encodeURIComponent(now.toISOString())}&order=created_at.desc&limit=100`, {}, fetcher),
    serviceRest(`rorc_receptionist_eval_cases?select=${evalSelect}&order=created_at.desc&limit=100`, {}, fetcher),
  ]);
  return {
    reviews: (reviews || []).map(mapReview),
    evalCases: (evalCases || []).map(mapEvalCase),
  };
}

async function updateReview(manager, body = {}, fetcher = fetch) {
  const id = String(body.id || "").trim();
  const status = String(body.status || "").trim();
  const category = String(body.issueCategory || "").trim();
  const expectedBehavior = cleanText(body.expectedBehavior, 2400);
  if (!validUuid(id)) throw httpError(400, "A valid review id is required.");
  if (!REVIEW_STATUSES.has(status) || status === "pending") throw httpError(400, "Choose corrected or dismissed.");
  if (!ISSUE_CATEGORIES.has(category)) throw httpError(400, "Choose a valid review category.");
  if (status === "corrected" && !expectedBehavior) throw httpError(400, "Describe what the receptionist should have done.");
  if (status === "dismissed" && category !== "correct") throw httpError(400, "Dismissed reviews must be marked correct.");
  if (status === "corrected" && category === "correct") throw httpError(400, "Corrected reviews need an issue category.");

  const existingRows = await serviceRest(
    `rorc_receptionist_review_items?select=id,caller_utterance,intent,expires_at&id=eq.${encodeURIComponent(id)}&limit=1`,
    {},
    fetcher,
  );
  const existing = existingRows?.[0];
  if (!existing) throw httpError(404, "Review item not found.");
  if (new Date(existing.expires_at).getTime() <= Date.now()) throw httpError(410, "This review item has expired.");

  let evalCase = null;
  if (Boolean(body.saveAsEval)) {
    if (status !== "corrected" || !EVAL_CATEGORIES.has(category)) {
      throw httpError(400, "Only corrected issues can become evaluation cases.");
    }
    const callerUtterance = cleanText(body.evalUtterance || existing.caller_utterance, 800);
    const expectedIntent = INTENTS.has(body.expectedIntent) ? body.expectedIntent : null;
    const requiredPhrases = cleanTextList(body.requiredPhrases);
    const forbiddenPhrases = cleanTextList(body.forbiddenPhrases);
    if (!callerUtterance) throw httpError(400, "Evaluation caller wording is required.");
    if (!expectedIntent && !requiredPhrases.length && !forbiddenPhrases.length) {
      throw httpError(400, "Add an expected intent or at least one answer phrase check.");
    }
    if (category === "wrong_action" && !expectedIntent) {
      throw httpError(400, "Choose the expected routing for a wrong-action test.");
    }
    if (category !== "wrong_action" && !requiredPhrases.length && !forbiddenPhrases.length) {
      throw httpError(400, "Add at least one required or forbidden answer phrase for this test.");
    }
    const rows = await serviceRest("rorc_receptionist_eval_cases?on_conflict=source_review_id", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        source_review_id: id,
        caller_utterance: callerUtterance,
        expected_behavior: expectedBehavior,
        expected_intent: expectedIntent,
        required_phrases: requiredPhrases,
        forbidden_phrases: forbiddenPhrases,
        issue_category: category,
        enabled: true,
        created_by_member_id: manager.id,
      }),
    }, fetcher);
    evalCase = mapEvalCase(rows?.[0] || {});
  }

  const reviewedAt = new Date().toISOString();
  const rows = await serviceRest(`rorc_receptionist_review_items?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      review_status: status,
      issue_category: category,
      expected_behavior: expectedBehavior || null,
      reviewed_by_member_id: manager.id,
      reviewed_at: reviewedAt,
    }),
  }, fetcher);
  return { review: mapReview(rows?.[0] || {}), evalCase };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (!SERVICE_KEY) return res.status(500).json({ success: false, error: "Supabase service access is not configured." });
  try {
    const manager = await requireAccountManager(req);
    if (req.method === "GET") {
      return res.status(200).json({ success: true, ...(await loadReviewData()) });
    }
    if (req.method === "PATCH") {
      return res.status(200).json({ success: true, ...(await updateReview(manager, req.body || {})) });
    }
    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Could not update receptionist reviews." });
  }
};

module.exports.bearerToken = bearerToken;
module.exports.cleanTextList = cleanTextList;
module.exports.loadReviewData = loadReviewData;
module.exports.mapEvalCase = mapEvalCase;
module.exports.mapReview = mapReview;
module.exports.requireAccountManager = requireAccountManager;
module.exports.updateReview = updateReview;
