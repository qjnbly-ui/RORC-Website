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

test("every incoming greeting naturally offers AI message-taking before the final question", () => {
  const greeting = incoming.withMessagePrompt(incoming.rotatingGreeting("", () => 0));
  const custom = incoming.withMessagePrompt("Welcome. Press zero and I can take a message.");

  assert.match(greeting, /take a message for him; just press 0 anytime/i);
  assert.ok(greeting.indexOf("press 0") < greeting.indexOf("Otherwise, what can I help you with?"));
  assert.equal((custom.match(/press zero/gi) || []).length, 1);
});
