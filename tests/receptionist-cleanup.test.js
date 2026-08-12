const test = require("node:test");
const assert = require("node:assert/strict");

test("cleanup authorization requires the exact cron bearer token", () => {
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cleanup-secret";
  delete require.cache[require.resolve("../api/cleanup-receptionist-data")];
  const { authorized } = require("../api/cleanup-receptionist-data");
  assert.equal(authorized({ headers: { authorization: "Bearer test-cleanup-secret" } }), true);
  assert.equal(authorized({ headers: { authorization: "Bearer wrong" } }), false);
  assert.equal(authorized({ headers: {} }), false);
  if (prior === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = prior;
});

test("cleanup covers draft and review expiry, seven-day wording removal, metadata retention, and stale lockouts", () => {
  const { cleanupOperations } = require("../api/cleanup-receptionist-data");
  const operations = cleanupOperations(new Date("2026-08-07T12:00:00Z"));
  assert.equal(operations.length, 6);
  assert.match(operations[0].path, /form_drafts\?expires_at=lt\./);
  assert.match(operations[1].path, /review_items\?expires_at=lt\./);
  assert.equal(operations[2].method, "PATCH");
  assert.deepEqual(operations[2].body, { utterance_text: null, utterance_expires_at: null });
  assert.match(decodeURIComponent(operations[3].path), /2026-02-08T12:00:00.000Z/);
  assert.match(decodeURIComponent(operations[5].path), /2026-07-08T12:00:00.000Z/);
});
