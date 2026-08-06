const assert = require("node:assert/strict");
const test = require("node:test");
const { parseSmsDestinations } = require("../api/_sms-destinations");

test("parses, trims, and deduplicates comma-separated SMS destinations", () => {
  assert.deepEqual(
    parseSmsDestinations("+15418916772, +15418914661, +15418916772"),
    ["+15418916772", "+15418914661"]
  );
});

test("uses the fallback destination when the setting is empty", () => {
  assert.deepEqual(parseSmsDestinations("", "+15418916772"), ["+15418916772"]);
});

test("rejects a malformed destination", () => {
  assert.throws(
    () => parseSmsDestinations("+15418916772, 541-891-4661"),
    /Invalid SMS destination/
  );
});
