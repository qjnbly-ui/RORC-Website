const { detectFormRequest } = require("./_rorc-forms");

const INTENTS = [
  "simple_question",
  "detailed_explanation",
  "send_information",
  "start_form",
  "check_account",
  "request_person",
];
const FORM_IDS = ["none", "membership", "rental", "sponsor"];
const FORM_ACTIONS = ["none", "offer", "guided", "send_link"];
const DETAIL_LEVELS = ["brief", "normal", "detailed"];
const HIGH_IMPACT = new Set(["send_information", "start_form", "check_account", "request_person"]);

const ROUTER_SCHEMA = {
  name: "rorc_receptionist_intent",
  strict: true,
  schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: INTENTS },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      topic: { type: "string" },
      detail_level: { type: "string", enum: DETAIL_LEVELS },
      form_id: { type: "string", enum: FORM_IDS },
      form_action: { type: "string", enum: FORM_ACTIONS },
      person_name: { type: "string" },
    },
    required: ["intent", "confidence", "topic", "detail_level", "form_id", "form_action", "person_name"],
    additionalProperties: false,
  },
};

const ROUTER_PROMPT = [
  "Classify the caller's newest request for the RORC AI receptionist.",
  "simple_question means a direct factual or yes/no question that needs at most three sentences.",
  "detailed_explanation means the caller explicitly requests details, comparison, requirements, or a step-by-step explanation.",
  "send_information means they ask to text or send information already discussed, but are not starting a specific form.",
  "start_form means they want to apply, sign up, sponsor, or rent; set form_id and form_action to offer, guided, or send_link.",
  "check_account means private information about their own membership, balance, billing, access, or account.",
  "request_person means they ask to speak with Quentin, staff, a person, or a human.",
  "A question such as 'Is the gym available for rent?' is simple_question, not start_form.",
  "A question about rental prices or rules is not start_form unless the caller says they want to apply, book, rent, or fill out the form.",
  "Use none for form fields when the intent is not start_form. Return only the required JSON object.",
].join(" ");

function validateIntentResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Intent router returned no object.");
  if (!INTENTS.includes(value.intent)) throw new Error("Intent router returned an unknown intent.");
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error("Intent router returned invalid confidence.");
  if (!DETAIL_LEVELS.includes(value.detail_level)) throw new Error("Intent router returned invalid detail level.");
  if (!FORM_IDS.includes(value.form_id) || !FORM_ACTIONS.includes(value.form_action)) throw new Error("Intent router returned invalid form data.");
  return {
    intent: value.intent,
    confidence: value.confidence,
    topic: String(value.topic || "").slice(0, 200),
    detail_level: value.detail_level,
    form_id: value.form_id,
    form_action: value.form_action,
    person_name: String(value.person_name || "").slice(0, 100),
    source: "model",
  };
}

async function classifyIntent(question, history = [], options = {}) {
  const key = String(options.apiKey || process.env.GROQ_API_KEY || "").trim();
  if (!key) throw new Error("GROQ_API_KEY is not configured.");
  const fetcher = options.fetch || fetch;
  const response = await fetcher("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: String(options.model || process.env.GROQ_RECEPTIONIST_ROUTER_MODEL || "openai/gpt-oss-20b"),
      temperature: 0,
      max_tokens: 260,
      response_format: { type: "json_schema", json_schema: ROUTER_SCHEMA },
      messages: [
        { role: "system", content: ROUTER_PROMPT },
        ...history.slice(-4).map((item) => ({ role: item.role, content: String(item.content || "").slice(0, 800) })),
        { role: "user", content: String(question || "").slice(0, 800) },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || "Intent router request failed.");
    error.status = response.status;
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || ""); }
  catch { throw new Error("Intent router returned invalid JSON."); }
  return validateIntentResult(parsed);
}

function narrowFallback(question, detectors = {}) {
  const text = String(question || "");
  const formId = (detectors.detectFormRequest || detectFormRequest)(text);
  if (detectors.isAccountRequest?.(text)) return { intent: "check_account", form_id: "none", form_action: "none" };
  if (detectors.isSmsRequest?.(text)) return { intent: "send_information", form_id: "none", form_action: "none" };
  if (formId) {
    const guided = detectors.isGuidedFormChoice?.(text);
    const direct = detectors.isDirectFormChoice?.(text);
    return { intent: "start_form", form_id: formId, form_action: guided ? "guided" : direct ? "send_link" : "offer" };
  }
  if (detectors.isPersonRequest?.(text)) return { intent: "request_person", form_id: "none", form_action: "none" };
  if (detectors.wantsDetailedAnswer?.(text)) return { intent: "detailed_explanation", form_id: "none", form_action: "none" };
  return { intent: "simple_question", form_id: "none", form_action: "none" };
}

function safeIntentResult(result, question, detectors = {}) {
  if (result?.confidence >= 0.65) return { ...result, needsClarification: false };
  const fallback = narrowFallback(question, detectors);
  const ambiguousAction = HIGH_IMPACT.has(result?.intent) && fallback.intent === "simple_question";
  return {
    ...fallback,
    confidence: Number(result?.confidence || 0),
    topic: String(result?.topic || question || "").slice(0, 200),
    detail_level: fallback.intent === "detailed_explanation" ? "detailed" : "brief",
    person_name: String(result?.person_name || ""),
    source: "fallback",
    needsClarification: ambiguousAction,
  };
}

function fallbackIntent(question, detectors = {}) {
  return safeIntentResult({ intent: "simple_question", confidence: 0, topic: question, person_name: "" }, question, detectors);
}

module.exports = {
  DETAIL_LEVELS,
  FORM_ACTIONS,
  FORM_IDS,
  INTENTS,
  ROUTER_SCHEMA,
  classifyIntent,
  fallbackIntent,
  narrowFallback,
  safeIntentResult,
  validateIntentResult,
};
