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

test("greetings are short enough to avoid a long unattended opening", () => {
  for (const greeting of incoming.GREETING_VARIANTS) {
    assert.ok(greeting.split(/\s+/).length <= 14, greeting);
  }
});
