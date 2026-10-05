const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sync = require('../api/_stripe-membership-sync');
process.env.STRIPE_PRICE_FULL_FACILITY_MONTHLY = 'price_full';

async function deliver({ invoices = [], billingStatus = 'active', paid = false, lookupFails = false } = {}) {
  const writes = [];
  const subscription = { id: 'sub_test', customer: 'cus_test', status: 'canceled', metadata: { rorc_account_id: 'old_signup_account' }, items: { data: [{ price: { id: 'price_full' }, current_period_end: 1000 }] } };
  const event = paid
    ? { type: 'invoice.paid', data: { object: { id: 'in_paid', amount_paid: 2000, parent: { subscription_details: { subscription: 'sub_test' } } } } }
    : { type: 'customer.subscription.deleted', data: { object: subscription } };
  const stripe = {
    webhooks: { constructEvent: () => event },
    subscriptions: { retrieve: async () => subscription },
    invoices: { list: async function* () { if (lookupFails) throw new Error('Invoice lookup failed'); yield* invoices; } }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/stripe-webhook'), 'utf8'), {
    module, Buffer, process: { env: { STRIPE_SECRET_KEY: 'test', STRIPE_WEBHOOK_SECRET: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test' } },
    require: name => name === 'stripe' ? () => stripe : sync,
    fetch: async (url, options = {}) => {
      const path = url.split('/rest/v1/')[1];
      if (options.method) writes.push({ path, payload: JSON.parse(options.body) });
      const data = path.startsWith('account_billing?') ? [{ account_id: 'account', billing_status: billingStatus }]
        : path.startsWith('account_members?') ? [{ id: 'member', account_type: 'Active Membership' }] : [];
      return { ok: true, json: async () => data };
    }
  });
  let status;
  await module.exports({ method: 'POST', rawBody: Buffer.from('{}'), headers: { 'stripe-signature': 'test' } }, {
    status(code) { status = code; return this; }, json() { return this; }
  });
  return { status, writes, billing: writes.find(w => w.path.startsWith('account_billing?'))?.payload };
}

test('uncollectible debt prevents canceled membership from becoming open gym', async () => {
  const result = await deliver({ invoices: [{ status: 'uncollectible', amount_remaining: 2000 }] });
  assert.equal(result.status, 200);
  assert.equal(result.billing.billing_status, 'past_due');
  assert.equal(result.billing.stripe_status, 'canceled');
  assert.equal(result.writes.find(w => w.path.startsWith('account_members?')).payload.account_type, 'Account Past Due NO ACCESS ALLOWED');
});
test('past-due history survives cancellation even when invoices were voided', async () => {
  const result = await deliver({ billingStatus: 'past_due', invoices: [{ status: 'void', amount_remaining: 0 }] });
  assert.equal(result.billing.billing_status, 'past_due');
});
test('settled voluntary cancellation allows open gym and retains Stripe reference', async () => {
  const result = await deliver();
  assert.equal(result.billing.billing_status, 'none');
  assert.equal(result.billing.stripe_subscription_id, 'sub_test');
  assert.equal(result.billing.current_period_end, '1970-01-01T00:16:40.000Z');
  assert.ok(result.writes.every(w => !w.path.includes('old_signup_account')));
});
test('payment after cancellation releases hold only when remaining debt is settled', async () => {
  assert.equal((await deliver({ paid: true, billingStatus: 'past_due' })).billing.billing_status, 'none');
  assert.equal((await deliver({ paid: true, billingStatus: 'past_due', invoices: [{ status: 'open', amount_remaining: 2000 }] })).billing.billing_status, 'past_due');
});
test('failed balance lookup retries webhook without granting open gym access', async () => {
  const result = await deliver({ lookupFails: true });
  assert.equal(result.status, 400);
  assert.deepEqual(result.writes, []);
});
