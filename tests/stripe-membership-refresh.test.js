const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sync = require('../api/_stripe-membership-sync');
process.env.STRIPE_PRICE_FULL_FACILITY_MONTHLY = 'price_full';

async function refresh({ debt = false, previous = 'none', actorType = 'Account Manager', owner = true } = {}) {
  const writes = [];
  const module = { exports: {} };
  const stripe = {
    subscriptions: { retrieve: async () => ({ id: 'sub_test', customer: 'cus_test', status: 'canceled', items: { data: [{ price: { id: 'price_full' } }] } }) },
    invoices: { list: async function* () { if (debt) yield { status: 'open', amount_remaining: 2000 }; } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/sync-stripe-membership'), 'utf8'), {
    module, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'test', STRIPE_SECRET_KEY: 'test' } },
    require: name => name === 'stripe' ? () => stripe : name === './_account-scope' ? { accountMemberFilter: async () => 'id=eq.actor' } : sync,
    fetch: async (url, options = {}) => {
      const path = url.split('/rest/v1/')[1] || '';
      if (options.method) writes.push({ path, payload: JSON.parse(options.body) });
      const data = url.includes('/auth/v1/user') ? { id: 'auth' }
        : path.includes('id=eq.actor') ? [{ id: 'actor', account_id: 'account', account_type: actorType, is_billing_owner: owner }]
        : path.startsWith('account_billing?') ? [{ account_id: 'account', stripe_subscription_id: 'sub_test', billing_status: previous }]
        : path.startsWith('account_members?') ? [{ id: 'member', account_type: 'Active Membership' }] : [];
      return { ok: true, json: async () => data };
    }
  });
  let status, body;
  await module.exports({ method: 'POST', headers: { authorization: 'Bearer test' }, body: { accountId: 'account' } }, {
    status(code) { status = code; return this; }, json(value) { body = value; return this; }
  });
  return { status, body, writes, billing: writes.find(w => w.path.startsWith('account_billing?'))?.payload };
}
test('billing refresh keeps settled canceled accounts on open gym', async () => {
  const result = await refresh();
  assert.equal(result.status, 200);
  assert.equal(result.billing.billing_status, 'none');
  assert.equal(result.billing.stripe_status, 'canceled');
});
test('billing refresh cannot clear unpaid cancellation or past-due history', async () => {
  assert.equal((await refresh({ debt: true })).billing.billing_status, 'past_due');
  assert.equal((await refresh({ previous: 'past_due' })).billing.billing_status, 'past_due');
});
test('non-owner members cannot change account billing through refresh', async () => {
  const result = await refresh({ actorType: 'Active Membership', owner: false });
  assert.equal(result.status, 403);
  assert.deepEqual(result.writes, []);
});
