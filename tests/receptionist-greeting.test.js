const test = require("node:test");
const assert = require("node:assert/strict");
const incoming = require("../api/receptionist/incoming");

test("recognized callers hear their first name", () => {
  assert.match(incoming.rotatingGreeting("Quentin Nichols", () => 0), /^Welcome back, Quentin\./);
});

test("greetings rotate across distinct introductions", () => {
  const first = incoming.rotatingGreeting("", () => 0);
  const last = incoming.rotatingGreeting("", () => 0.999);
  assert.notEqual(first, last);
  assert.match(first, /RORC AI receptionist/);
  assert.match(last, /RORC AI receptionist/);
});

test("every incoming greeting offers voicemail without duplicating a custom prompt", () => {
  const greeting = incoming.withVoicemailPrompt(incoming.rotatingGreeting("", () => 0));
  const custom = incoming.withVoicemailPrompt("Welcome. Press zero for voicemail.");

  assert.match(greeting, /press 0 at any time to leave a voicemail/i);
  assert.equal((custom.match(/press zero/gi) || []).length, 1);
});
