const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLine, finishPreview, validateDates, facilityDate } = require('../.build/closure-credits/calculation');
const { previewAccount, applyAccount, default: handler } = require('../.build/closure-credits/server');
process.env.STRIPE_PRICE_WEIGHT_ROOM_MONTHLY = 'price_weight';
process.env.STRIPE_PRICE_FULL_FACILITY_MONTHLY = 'price_full';
process.env.STRIPE_PRICE_FULL_FACILITY_WIFI_MONTHLY = 'price_wifi';
process.env.STRIPE_PRICE_OPEN_GYM_MONTHLY = 'price_open';
const seconds = (date) => Date.parse(`${date}T12:00:00-07:00`) / 1000;
const closure = { id: 'closure-1', starts_on: '2026-09-08', reopens_on: '2026-09-22', reason: 'Maintenance', status: 'draft' };
function line(overrides = {}) {
  return { id: 'il_1', amount: 2000, currency: 'usd', period: { start: seconds('2026-09-01'), end: seconds('2026-10-01') }, pricing: { price_details: { price: 'price_full' } }, parent: { subscription_item_details: { proration: false } }, ...overrides };
}
function fakeStripe(invoices = []) {
  const transactions = [];
  return {
    transactions,
    invoices: { list: () => invoices, listLineItems: () => { throw new Error('unexpected pagination'); } },
    invoicePayments: { list: () => [] },
    subscriptions: { list: () => [{ status: 'active', items: { data: [{ price: { id: 'price_full' } }] } }] },
    customers: {
      listBalanceTransactions: () => transactions,
      createBalanceTransaction: async (customer, body, options) => {
        assert.equal(customer, 'cus_1');
        assert.equal(options.idempotencyKey, 'rorc-closure-credit-row-1');
        const t = { id: 'cbtxn_1', ...body }; transactions.push(t); return t;
      }
    }
  };
}
function invoice(lines, overrides = {}) { return { id: 'in_1', status: 'paid', lines: { data: lines, has_more: false }, ...overrides }; }

test('September closure credits $10, $20 and $25 plans; reopening day is excluded', () => {
  for (const [amount, expected] of [[1000, 467], [2000, 933], [2500, 1167]]) {
    const result = calculateLine(line({ amount }), 'in_1', 'Gym', closure);
    assert.equal(result.creditCents, expected);
    assert.equal(result.closedDays, 14);
    assert.equal(result.periodDays, 30);
  }
});
test('credits span billing periods with each period’s own denominator', () => {
  const a = calculateLine(line({ period: { start: seconds('2026-08-15'), end: seconds('2026-09-15') } }), 'in_1', 'Gym', closure);
  const b = calculateLine(line({ id: 'il_2', period: { start: seconds('2026-09-15'), end: seconds('2026-10-15') } }), 'in_2', 'Gym', closure);
  assert.equal(a.closedDays, 7); assert.equal(a.periodDays, 31);
  assert.equal(b.closedDays, 7); assert.equal(b.periodDays, 30);
  assert.equal(finishPreview([a,b], []).amount, 919);
});
test('full-period credits are capped at the discounted charge', () => {
  const result = calculateLine(line({ discount_amounts: [{ amount: 500 }] }), 'in_1', 'Gym', { ...closure, starts_on: '2026-08-01', reopens_on: '2026-11-01' });
  assert.equal(result.creditCents, 1500);
  assert.equal(calculateLine(line({ discount_amounts: [{ amount: 2000 }] }), 'in_1', 'Gym', closure).creditCents, 0);
});
test('calendar days are stable across DST and leap-year periods', () => {
  const l = line({ period: { start: Date.parse('2026-03-01T08:00:00Z')/1000, end: Date.parse('2026-04-01T07:00:00Z')/1000 } });
  const result = calculateLine(l, 'in_1', 'Gym', { ...closure, starts_on: '2026-03-01', reopens_on: '2026-04-01' });
  assert.equal(result.periodDays,31); assert.equal(result.creditCents,2000);
  assert.equal(facilityDate(Date.parse('2026-09-09T02:00:00Z')/1000), '2026-09-08');
  const leap = calculateLine(line({ period: { start: seconds('2024-02-01'), end: seconds('2024-03-01') } }), 'in_1', 'Gym', { ...closure, starts_on: '2024-02-01', reopens_on: '2024-03-01' });
  assert.equal(leap.periodDays,29);
});
test('invalid dates, future reopening, unsupported periods and prorations fail safely', () => {
  for (const [start,end] of [['2026-02-30','2026-03-05'],['2026-09-08','2026-09-08'],['2026-09-09','2026-09-08'],['2099-01-01','2099-02-01']]) assert.throws(() => validateDates(start,end));
  assert.throws(() => calculateLine(line({ amount: -100 }), 'in', 'Gym', closure), /manual review/);
  assert.throws(() => calculateLine(line({ parent: { subscription_item_details: { proration: true } } }), 'in', 'Gym', closure), /manual review/);
  assert.throws(() => calculateLine(line({ currency:'eur' }), 'in', 'Gym', closure), /manual review/);
  assert.equal(calculateLine(line(), 'in', 'Gym', { ...closure, starts_on: '2026-10-01', reopens_on: '2026-10-02' }), null);
});
test('only paid configured gym subscription lines are eligible', async () => {
  const s = fakeStripe([invoice([line(),line({ id:'rental', parent:null, pricing:{price_details:{price:'price_rental'}} }),line({ id:'open_gym',pricing:{price_details:{price:'price_open'}} }),line({id:'manual',parent:null})])]);
  const p = await previewAccount(s,'cus_1',closure);
  assert.equal(p.amount,933); assert.equal(p.details.length,1); assert.deepEqual(p.warnings,[]);
});
test('unpaid invoices, credit notes, overlapping periods and canceled memberships require review', async () => {
  for (const inv of [invoice([line()],{status:'open'}),invoice([line()],{post_payment_credit_notes_amount:10}),invoice([line(),line({id:'il_2'})])]) {
    assert.ok((await previewAccount(fakeStripe([inv]),'cus_1',closure)).warnings.length);
  }
  const s = fakeStripe([invoice([line()])]); s.subscriptions.list = () => [];
  assert.match((await previewAccount(s,'cus_1',closure)).warnings[0], /No continuing/);
});
test('a direct payment refund prevents automatic credit', async () => {
  const s = fakeStripe([invoice([line()])]);
  s.invoicePayments.list = () => [{payment:{payment_intent:'pi_1'}}];
  s.refunds = { list: () => [{status:'succeeded'}] };
  assert.match((await previewAccount(s,'cus_1',closure)).warnings[0],/refund/);
});
test('pagination is consumed and failures never save a partial preview', async () => {
  const s = fakeStripe([invoice([],{lines:{data:[],has_more:true}})]);
  s.invoices.listLineItems = async function* () { yield line(); };
  assert.equal((await previewAccount(s,'cus_1',closure)).amount,933);
  s.invoices.listLineItems = async function* () { yield line(); throw new Error('Stripe offline'); };
  await assert.rejects(previewAccount(s,'cus_1',closure), /Stripe offline/);
});
test('retry after a lost database save recovers the existing Stripe credit', async () => {
  const s = fakeStripe([invoice([line()])]);
  const preview = await previewAccount(s,'cus_1',closure);
  const row = {id:'row-1',account_id:'account-1',customer_id:'cus_1',state:'applying',amount_cents:preview.amount,fingerprint:preview.fingerprint};
  assert.equal(await applyAccount(s,closure,row),'cbtxn_1');
  assert.equal(await applyAccount(s,closure,row),'cbtxn_1');
  assert.equal(s.transactions.length,1);
  assert.equal(s.transactions[0].amount,-933);
  await assert.rejects(applyAccount(s,closure,{...row,amount_cents:934}),/does not match/);
});
test('API rejects other methods without making a service request', async () => {
  let status;
  const response = { setHeader(){}, status(code){ status=code;return this; }, json(){} };
  await handler({method:'GET'},response);
  assert.equal(status,405);
});

test('API requires a valid authenticated account manager for reads and writes', async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const previousStripeKey = process.env.STRIPE_SECRET_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
  process.env.STRIPE_SECRET_KEY = 'test-stripe';
  const modulePath = require.resolve('../.build/closure-credits/server');
  delete require.cache[modulePath];
  const securedHandler = require(modulePath).default;
  let calls = 0;
  global.fetch = async url => {
    calls++;
    if (String(url).includes('/auth/v1/user')) return Response.json({id:'member-user'});
    if (String(url).includes('/account_members?')) return Response.json([{id:'member-1',account_type:'Active Membership'}]);
    throw new Error('Non-manager reached billing storage');
  };
  async function invoke(authorization,action) {
    const response = {statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;}};
    await securedHandler({method:'POST',headers:{authorization},body:{action}},response);
    return response;
  }
  try {
    assert.equal((await invoke('', 'list')).statusCode,401);
    assert.equal(calls,0);
    assert.equal((await invoke('Bearer member', 'list')).statusCode,403);
    assert.equal((await invoke('Bearer member', 'create')).statusCode,403);
    assert.equal((await invoke('Bearer member', 'apply')).statusCode,403);
    global.fetch=async()=>Response.json({error:'Invalid token'},{status:401});
    assert.equal((await invoke('Bearer invalid','list')).statusCode,401);
  } finally {
    global.fetch=previousFetch;
    if(previousKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=previousKey;
    if(previousStripeKey===undefined)delete process.env.STRIPE_SECRET_KEY;else process.env.STRIPE_SECRET_KEY=previousStripeKey;
    delete require.cache[modulePath];
  }
});
