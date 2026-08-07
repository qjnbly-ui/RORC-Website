const test = require("node:test");
const assert = require("node:assert/strict");
const receptionist = require("../api/receptionist/conversation");

test("membership questions retrieve membership website content", () => {
  const context = receptionist.websiteContext("How much does a weight room membership cost?");
  assert.match(context, /Weight Room Only/i);
  assert.match(context, /\$10/);
});

test("ordinary website questions do not request a person", () => {
  assert.equal(receptionist.isPersonRequest("What events are happening this week?"), false);
});

test("unscreened transfer requests require a reason", () => {
  assert.equal(receptionist.isPersonRequest("Can I speak with Quentin?"), true);
  assert.equal(receptionist.hasTransferReason("Can I speak with Quentin?"), false);
});

test("a specific RORC transfer reason can proceed", () => {
  const request = "Can I speak with Quentin about my rental reservation problem?";
  assert.equal(receptionist.isPersonRequest(request), true);
  assert.equal(receptionist.hasTransferReason(request), true);
});

test("human fallback is reserved for unresolved answers", () => {
  assert.equal(receptionist.replyNeedsHuman("Membership is ten dollars per month."), false);
  assert.equal(receptionist.replyNeedsHuman("I cannot confirm that from the website information."), true);
});

test("natural requests to send information are recognized as SMS requests", () => {
  assert.equal(receptionist.isSmsRequest("Can you send me that link?"), true);
  assert.equal(receptionist.isSmsRequest("Please share the rental page with me."), true);
  assert.equal(receptionist.isSmsRequest("What does a membership cost?"), false);
});

test("SMS links point to the relevant RORC page", () => {
  assert.equal(receptionist.smsDestination("Text me the rental information", []), "https://www.ruthobenchainrc.com/rentals/");
  assert.equal(receptionist.smsDestination("Send me that link", [
    { role: "user", content: "How do I join RORC?" },
    { role: "assistant", content: "You can enroll on the membership signup page." },
  ]), "https://www.ruthobenchainrc.com/membership-signup/");
});
