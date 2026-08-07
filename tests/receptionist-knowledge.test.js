const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildKnowledge, serializedKnowledge } = require("../scripts/build-receptionist-knowledge");

test("committed receptionist knowledge exactly matches public source pages", () => {
  const destination = path.join(__dirname, "..", "api", "rorc-site-knowledge.json");
  assert.equal(fs.readFileSync(destination, "utf8"), serializedKnowledge());
  assert.match(buildKnowledge().contentHash, /^[a-f0-9]{64}$/);
});
