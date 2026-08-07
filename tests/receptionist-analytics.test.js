const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateAnalytics, bearerToken, percentile, requireAccountManager } = require("../api/receptionist-analytics");
const { hashCaller } = require("../api/_receptionist-analytics");

test("analytics aggregate call, intent, latency, outcome, and issue data", () => {
  const calls = [
    { ended_at: "2026-08-07T01:02:00Z", caller_recognized: true, account_verified: true, final_outcome: "answered" },
    { ended_at: null, caller_recognized: false, account_verified: false, final_outcome: null },
  ];
  const events = [
    { event_type: "intent_routed", intent: "simple_question", confidence: 0.9, latency_ms: 100, success: true, metadata: { source: "model" } },
    { event_type: "intent_routed", intent: "start_form", confidence: 0.4, latency_ms: 300, success: true, metadata: { source: "fallback" }, utterance_text: "help with a rental", created_at: "2026-08-07T01:00:00Z" },
    { event_type: "answer_generated", latency_ms: 900, success: true },
    { event_type: "sms_sent", twilio_message_sid: "SM1", success: false, error_code: "twilio_30007" },
    { event_type: "transfer_requested", success: true },
  ];
  const data = aggregateAnalytics(calls, events);
  assert.equal(data.summary.calls, 2);
  assert.equal(data.summary.completionRate, 50);
  assert.equal(data.intents.simple_question, 1);
  assert.equal(data.activity.routerFallbacks, 1);
  assert.equal(data.activity.smsFailures, 1);
  assert.equal(data.activity.transfers, 1);
  assert.equal(data.latency.routeP95Ms, 300);
  assert.equal(data.recentIssues[0].wording, "help with a rental");
});

test("percentile handles empty and ordered values", () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([30, 10, 20], 0.5), 20);
});

test("caller analytics use a keyed hash instead of a stored phone number", () => {
  const hash = hashCaller("(541) 652-6065", "a-test-secret-that-is-not-used-in-production");
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(hash, /5416526065/);
  assert.equal(hash, hashCaller("+1 541 652 6065", "a-test-secret-that-is-not-used-in-production"));
  assert.notEqual(hash, hashCaller("+1 541 652 6065", "a-different-secret"));
});

test("analytics authorization accepts only an Account Manager session", async () => {
  assert.equal(bearerToken({ headers: { authorization: "Bearer abc123" } }), "abc123");
  let requestCount = 0;
  const managerFetch = async () => ({
    ok: true,
    json: async () => (++requestCount === 1 ? { id: "user-1" } : [{ id: "member-1", account_type: "Account Manager" }]),
  });
  const manager = await requireAccountManager("token", managerFetch);
  assert.equal(manager.id, "member-1");

  requestCount = 0;
  const memberFetch = async () => ({
    ok: true,
    json: async () => (++requestCount === 1 ? { id: "user-2" } : [{ id: "member-2", account_type: "Active Membership" }]),
  });
  await assert.rejects(() => requireAccountManager("token", memberFetch), /Only account managers/);
});
