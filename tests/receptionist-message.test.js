const test = require("node:test");
const assert = require("node:assert/strict");
const receptionist = require("../api/receptionist/conversation");
const {
  callerContact,
  deliverReceptionistMessage,
  staffMessageContent,
} = require("../api/_receptionist-message");

test("zero and natural spoken requests stay in the AI message flow", () => {
  assert.equal(receptionist.isMessageKeyRequest({ type: "dtmf", digit: "0" }), true);
  assert.equal(receptionist.isMessageKeyRequest({ type: "dtmf", digit: "1" }), false);
  assert.equal(receptionist.isStaffMessageRequest("Can I leave a message for Quentin?"), true);
  assert.equal(receptionist.isStaffMessageRequest("Please text me the rental link"), false);
});

test("recognized callers contribute their saved contact information", () => {
  const contact = callerContact({
    member: {
      member_name: "Quentin Nichols",
      email_address: "Q@example.com",
    },
  }, "(541) 891-6772");
  assert.deepEqual(contact, {
    name: "Quentin Nichols",
    phone: "+15418916772",
    email: "q@example.com",
  });
});

test("staff message content includes contact details and escapes email HTML", () => {
  const content = staffMessageContent({
    message: "Please call me about <the rental>.",
    contact: { name: "Pat & Sam", phone: "+15415550123", email: "pat@example.com" },
  });
  assert.match(content.text, /From: Pat & Sam/);
  assert.match(content.text, /Phone: \+15415550123/);
  assert.match(content.text, /Email: pat@example\.com/);
  assert.match(content.html, /Pat &amp; Sam/);
  assert.match(content.html, /&lt;the rental&gt;/);
});

test("confirmed messages are delivered to Quentin by text and email", async () => {
  const calls = [];
  const result = await deliverReceptionistMessage({
    callSid: "CA123",
    message: "Please call me back.",
    contact: { name: "Pat", phone: "+15415550123", email: "pat@example.com" },
  }, {
    config: {
      smsNumber: "+15415550999",
      emailAddress: "quentin@example.com",
      resendApiKey: "test-key",
      resendFrom: "RORC <no-reply@example.com>",
    },
    sendSmsFn: async (to, body) => { calls.push({ channel: "text", to, body }); },
    sendEmailFn: async (payload) => { calls.push({ channel: "email", payload }); },
  });

  assert.deepEqual(result, { emailSent: true, textSent: true });
  assert.equal(calls[0].to, "+15415550999");
  assert.match(calls[0].body, /Please call me back/);
  assert.deepEqual(calls[1].payload.to, ["quentin@example.com"]);
  assert.deepEqual(calls[1].payload.replyTo, ["pat@example.com"]);
  assert.equal(calls[1].payload.idempotencyKey, "receptionist-message-CA123");
});
