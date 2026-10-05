const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function move(targetExists) {
  const writes = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/move-member-account'), 'utf8'), {
    module, URLSearchParams, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'test' } },
    fetch: async (url, options = {}) => {
      if (options.method) writes.push({ url, payload: JSON.parse(options.body) });
      let data = [];
      if (url.includes('/auth/v1/user')) data = { id: 'admin_auth' };
      else if (url.includes('auth_user_id=')) data = [{ id: 'admin', account_type: 'Account Manager' }];
      else if (url.includes('account_members?') && url.includes('id=eq.member')) data = [{ id: 'member', account_id: 'source', is_billing_owner: true }];
      else if (url.includes('account_members?')) data = [{ id: 'member' }];
      else if (url.includes('account_billing?')) data = [{ stripe_customer_id: 'cus_test', stripe_subscription_id: 'sub_test' }];
      else if (url.includes('accounts?') && !options.method) data = targetExists ? [{ id: 'target' }] : [];
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
test('moving a billed member into another account stops before changing any records', async () => {
  const result = await move(true);
  assert.equal(result.status, 409);
  assert.deepEqual(result.writes, []);
});
