const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const priorServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
delete require.cache[require.resolve("../api/receptionist-reviews")];
delete require.cache[require.resolve("../api/_receptionist-analytics")];
const reviews = require("../api/receptionist-reviews");
const analytics = require("../api/_receptionist-analytics");
const { scoreAnswerCase } = require("../scripts/eval-receptionist-feedback");

test.after(() => {
  if (priorServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = priorServiceKey;
});

test("review text assertions are normalized, deduplicated, and bounded", () => {
  assert.deepEqual(reviews.cleanTextList(" price is ten dollars \nprice is ten dollars\n no annual fee "), [
    "price is ten dollars",
    "no annual fee",
  ]);
  assert.equal(reviews.cleanTextList(Array.from({ length: 20 }, (_, index) => `item ${index}`)).length, 12);
});

test("a corrected review can create a reusable evaluation case", async () => {
  const calls = [];
  const reviewId = "11111111-1111-4111-8111-111111111111";
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("rorc_receptionist_review_items?select=")) {
      return response([{ id: reviewId, caller_utterance: "How much is a membership?", intent: "simple_question", expires_at: "2099-01-01T00:00:00Z" }]);
    }
    if (url.includes("rorc_receptionist_eval_cases")) {
      return response([{ id: "eval-1", source_review_id: reviewId, caller_utterance: "How much is a membership?", expected_behavior: "State the current monthly price.", expected_intent: "simple_question", required_phrases: ["ten dollars"], forbidden_phrases: [], issue_category: "wrong_information", enabled: true }]);
    }
    return response([{ id: reviewId, review_status: "corrected", issue_category: "wrong_information", expected_behavior: "State the current monthly price." }]);
  };
  const result = await reviews.updateReview({ id: "manager-1" }, {
    id: reviewId,
    status: "corrected",
    issueCategory: "wrong_information",
    expectedBehavior: "State the current monthly price.",
    saveAsEval: true,
    evalUtterance: "How much is a membership?",
    expectedIntent: "simple_question",
    requiredPhrases: "ten dollars",
  }, fetcher);
  assert.equal(result.review.status, "corrected");
  assert.equal(result.evalCase.requiredPhrases[0], "ten dollars");
  assert.equal(calls.length, 3);
  assert.match(calls[1].options.headers.Prefer, /resolution=merge-duplicates/);
  assert.equal(JSON.parse(calls[1].options.body).created_by_member_id, "manager-1");
});

test("answer evaluation checks required and forbidden phrases", () => {
  const item = { expectedIntent: "simple_question", requiredPhrases: ["ten dollars"], forbiddenPhrases: ["twenty dollars"] };
  assert.equal(scoreAnswerCase(item, { intent: "simple_question", reply: "It costs ten dollars monthly." }).correct, true);
  assert.equal(scoreAnswerCase(item, { intent: "simple_question", reply: "It costs twenty dollars." }).correct, false);
});

test("flagged review capture sends only bounded review fields", async () => {
  const priorFetch = global.fetch;
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ id: "review-1" }]),
    };
  };
  try {
    await analytics.recordReviewItem("CA123", {
      utterance: "What does membership cost?",
      response: "It costs ten dollars per month.",
      reasons: ["low_confidence", "low_confidence"],
      intent: "simple_question",
      confidence: 0.4,
      routeSource: "fallback",
      promptVersion: "prompt-v1",
    });
  } finally {
    global.fetch = priorFetch;
  }
  assert.deepEqual(payload.review_reasons, ["low_confidence"]);
  assert.equal(payload.call_sid, "CA123");
  assert.equal(payload.prompt_version, "prompt-v1");
  assert.equal(payload.caller_utterance, "What does membership cost?");
});

test("review migration keeps both tables service-only with RLS", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20260812052430_add_receptionist_review_queue.sql"), "utf8");
  assert.match(migration, /alter table public\.rorc_receptionist_review_items enable row level security/i);
  assert.match(migration, /alter table public\.rorc_receptionist_eval_cases enable row level security/i);
  assert.match(migration, /revoke all on table public\.rorc_receptionist_review_items from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.rorc_receptionist_eval_cases to service_role/i);
});

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}
