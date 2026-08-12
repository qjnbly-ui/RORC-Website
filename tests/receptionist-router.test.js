const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/receptionist-intents.json");
const router = require("../api/_receptionist-router");
const receptionist = require("../api/receptionist/conversation");

const detectors = {
  isAccountRequest: (value) => /\bmy\b.*\b(account|membership|balance)\b/i.test(value),
  isSmsRequest: receptionist.isSmsRequest,
  isPersonRequest: receptionist.isPersonRequest,
  wantsDetailedAnswer: receptionist.wantsDetailedAnswer,
  isGuidedFormChoice: receptionist.isGuidedFormChoice,
  isDirectFormChoice: (value) => /\b(send|text|link)\b/i.test(value),
};

test("strict router request uses the required JSON schema", async () => {
  let payload;
  const result = await router.classifyIntent("Is the gym available for rent?", [], {
    apiKey: "test-key",
    fetch: async (_url, options) => {
      payload = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          intent: "simple_question", confidence: 0.98, topic: "rental availability",
          detail_level: "brief", form_id: "none", form_action: "none", person_name: "",
          live_data: "events", live_fact: "rental_availability",
        }) } }] }),
      };
    },
  });
  assert.equal(result.intent, "simple_question");
  assert.equal(payload.model, "openai/gpt-oss-20b");
  assert.equal(payload.reasoning_effort, "low");
  assert.equal(payload.max_completion_tokens, 640);
  assert.equal(payload.max_tokens, undefined);
  assert.equal(payload.response_format.type, "json_schema");
  assert.equal(payload.response_format.json_schema.strict, true);
  assert.equal(payload.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(result.live_data, "events");
  assert.equal(result.live_fact, "rental_availability");
});

test("invalid structured output is rejected", () => {
  assert.throws(() => router.validateIntentResult({ intent: "unknown", confidence: 1 }), /unknown intent/);
});

test("router rejects an explicitly truncated structured completion", async () => {
  await assert.rejects(
    router.classifyIntent("When is the gym busiest?", [], {
      apiKey: "test-key",
      fetch: async () => ({
        ok: true,
        json: async () => ({ choices: [{ finish_reason: "length", message: { content: '{"intent":"simple_question"' } }] }),
      }),
    }),
    /incomplete \(length\)/
  );
});

test("low-confidence actions fall back narrowly and require clarification when ambiguous", () => {
  const ambiguous = router.safeIntentResult({
    intent: "start_form", confidence: 0.4, topic: "rental availability", detail_level: "brief",
    form_id: "rental", form_action: "offer", person_name: "", source: "model",
  }, "Is the gym available for rent?", detectors);
  assert.equal(ambiguous.intent, "simple_question");
  assert.equal(ambiguous.needsClarification, true);

  const direct = router.safeIntentResult({
    intent: "request_person", confidence: 0.4, topic: "Quentin", detail_level: "brief",
    form_id: "none", form_action: "none", person_name: "Quentin", source: "model",
  }, "Can I speak with Quentin?", detectors);
  assert.equal(direct.intent, "request_person");
  assert.equal(direct.needsClarification, false);
  assert.equal(direct.source, "fallback");
});

test("intent evaluation fixture covers every route with substantial caller wording", () => {
  assert.ok(fixture.length >= 50);
  assert.deepEqual([...new Set(fixture.map((item) => item.intent))].sort(), [...router.INTENTS].sort());
  assert.equal(new Set(fixture.map((item) => item.phrase.toLowerCase())).size, fixture.length);
});

test("router detail level overrides regex answer limits", () => {
  assert.deepEqual(receptionist.responseLimits("Tell me about rentals", "brief"), { maxTokens: 110, maxSentences: 3 });
  assert.deepEqual(receptionist.responseLimits("Is it open?", "detailed"), { maxTokens: 600, maxSentences: 10 });
});
