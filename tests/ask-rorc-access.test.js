const test = require("node:test");
const assert = require("node:assert/strict");
const { recordsFor } = require("../api/_ask-rorc-records");

function fixture(t, primary, role) {
  const reads = [];
  t.mock.method(global, "fetch", async (url, options) => {
    reads.push({url, headers: {...options.headers}});
    if (url.includes("list_my_accounts")) return Response.json([{account_member_id:"abc", account_id:"family", is_primary:primary}]);
    if (url.includes("account_member_profiles")) return Response.json([{account_type:role}]);
    return Response.json([], {headers:{"content-range":"*/0"}});
  });
  const open = (id = "abc") => recordsFor({headers:{"x-rorc-account-member":id}}, "test-jwt");
  return {open, reads};
}
test("member lookups keep the caller JWT and enforce the selected account", async t => {
  const {open, reads} = fixture(t, true, "Member");
  await assert.rejects(open("other"), {status:403});
  const records = await open();
  const before = reads.length;
  assert.ok((await records.lookup({dataset:"visits", scope:"center"})).error);
  assert.ok((await records.lookup({dataset:"sponsorships", scope:"own"})).error);
  assert.equal(reads.length, before);
  await records.lookup({dataset:"bookings",scope:"own",account_id:"other"});
  assert.match(reads.at(-1).url, /claimed_account_id=eq.family/);
  assert.equal(reads.at(-1).headers.Authorization, "Bearer test-jwt");
});
test("a primary manager can read center visits", async t => {
  const {open, reads} = fixture(t, true, "Account Manager");
  const records = await open();
  assert.equal(records.manager, true);
  assert.equal((await records.lookup({dataset:"visits",scope:"center"})).total, 0);
  assert.doesNotMatch(reads.at(-1).url, /member_id=eq/);
});
test("linked accounts cannot confer manager access", async t => {
  const {open} = fixture(t, false, "Account Manager");
  const records = await open();
  assert.equal(records.manager, false);
  assert.ok((await records.lookup({dataset:"visits", scope:"center"})).error);
});
test("kiosk has no private datasets", async t => {
  assert.deepEqual((await fixture(t,true,"Kiosk Account").open()).datasets, []);
});
