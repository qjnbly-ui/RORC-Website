const test = require("node:test");
const assert = require("node:assert/strict");
const receptionist = require("../api/receptionist/conversation");
const { detectFormRequest, getFormDefinition } = require("../api/_rorc-forms");
const { tokenHash, sanitizedAnswers } = require("../api/_rorc-form-drafts");

test("detects all public RORC form requests", () => {
  assert.equal(detectFormRequest("I want to join RORC"), "membership");
  assert.equal(detectFormRequest("I would like to rent the facility"), "rental");
  assert.equal(detectFormRequest("Help me renew my sponsorship"), "sponsor");
  assert.equal(detectFormRequest("How much is a membership?"), "");
});

test("recognizes guided form choice", () => {
  assert.equal(receptionist.isGuidedFormChoice("Help me fill it out"), true);
  assert.equal(receptionist.isGuidedFormChoice("Just send the link"), false);
});

test("normalizes common spoken form values without sending them to an AI model", async () => {
  assert.equal(receptionist.spokenEmail("quentin dot nichols at example dot com"), "quentin.nichols@example.com");
  assert.equal(receptionist.spokenDate("August 20th", new Date("2026-08-06T12:00:00Z")), "2026-08-20");
  assert.equal(receptionist.spokenTime("seven thirty p m"), "19:30");
  assert.equal(receptionist.spokenNumber("one hundred twenty"), 120);
  assert.equal(receptionist.spokenPhone("five four one six five two six zero six five"), "+15416526065");
  const plan = getFormDefinition("membership").fields[0];
  assert.deepEqual(await receptionist.normalizeFormAnswer(plan, "full facility plus wifi", ""), { skipped: false, value: "full_facility_wifi" });
});

test("draft storage keeps only fields allowed by the selected form", () => {
  const form = getFormDefinition("membership");
  assert.deepEqual(sanitizedAnswers(form, {
    primaryName: "Taylor Example",
    planId: "weight_room",
    primaryPassword: "must-not-be-stored",
    primaryPin: "1234",
  }), { primaryName: "Taylor Example", planId: "weight_room" });
  assert.match(tokenHash("sample-token"), /^[a-f0-9]{64}$/);
});
