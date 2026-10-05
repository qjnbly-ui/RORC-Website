const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function move(targetExists, { memberCount = 1, billed = true, billingOwner = true, targetId = 'target' } = {}) {
  const writes = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/move-member-account'), 'utf8'), {
    module, URLSearchParams, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'test' } },
    fetch: async (url, options = {}) => {
      if (options.method) writes.push({ url, payload: JSON.parse(options.body) });
      let data = [];
      if (url.includes('/auth/v1/user')) data = { id: 'admin_auth' };
      else if (url.includes('auth_user_id=')) data = [{ id: 'admin', account_type: 'Account Manager' }];
      else if (url.includes('account_members?') && url.includes('id=eq.member')) data = [{ id: 'member', account_id: 'source', is_billing_owner: billingOwner }];
      else if (url.includes('account_members?')) data = Array.from({ length: memberCount }, (_, i) => ({ id: `member${i}` }));
      else if (url.includes('account_billing?')) data = billed ? [{ stripe_customer_id: 'cus_test', stripe_subscription_id: 'sub_test' }] : [];
      else if (url.includes('accounts?') && !options.method) data = targetExists ? [{ id: targetId }] : [];
      return { ok: true, json: async () => data };
    }
  });
  let status, body;
  await module.exports({ method: 'POST', headers: { authorization: 'Bearer test' }, body: { memberId: 'member', targetAccountNumber: '#30' } }, {
    status(code) { status = code; return this; }, json(value) { body = value; return this; }
  });
  return { status, body, writes };
}
test('renumbering a sole-member Stripe account preserves its account ID and billing', async () => {
  const result = await move(false);
  assert.equal(result.status, 200);
  assert.equal(result.body.targetAccountId, 'source');
  assert.equal(result.writes.length, 1);
  assert.ok(result.writes[0].url.endsWith('accounts?id=eq.source'));
  assert.equal(result.writes[0].payload.account_number, '#30');
});
test('moving an additional family member into an existing account still works', async () => {
  const result = await move(true, { memberCount: 3, billed: true, billingOwner: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.targetAccountId, 'target');
  assert.equal(result.writes.length, 1);
  assert.ok(result.writes[0].url.endsWith('account_members?id=eq.member'));
  assert.equal(result.writes[0].payload.account_id, 'target');
});
test('unbilled non-owner member can join an existing account', async () => {
  const result = await move(true, { billed: false, billingOwner: false });
  assert.equal(result.status, 200);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].payload.account_id, 'target');
});
test('saving the current account number does not write or move anything', async () => {
  const result = await move(true, { targetId: 'source' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.writes, []);
});
test('assigning a key number keeps a family account and its billing together', async () => {
  const result = await move(false, { memberCount: 3 });
  assert.equal(result.status, 200);
  assert.equal(result.body.targetAccountId, 'source');
  assert.equal(result.writes.length, 1);
  assert.ok(result.writes[0].url.endsWith('accounts?id=eq.source'));
});
test('assigning a key number also preserves an account before Stripe billing exists', async () => {
  const result = await move(false, { memberCount: 2, billed: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.targetAccountId, 'source');
  assert.equal(result.writes.length, 1);
});
test('moving a billed member into another account stops before changing any records', async () => {
  const result = await move(true);
  assert.equal(result.status, 409);
  assert.deepEqual(result.writes, []);
});
