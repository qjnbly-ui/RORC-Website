const test = require('node:test');
const assert = require('node:assert/strict');
const { createSponsorInvoice } = require('../api/_sponsor-invoice');

function fixture(overrides = {}) {
  let row = { id: 'sponsor-1', sponsorship_type: 'new', amount_cents: 12500,
    price_acknowledged: true, payment_method: 'stripe_invoice', status: 'in_review',
    email_address: 'sponsor@example.test', business_name: 'Test Sponsor', ...overrides };
  let invoice;
  let lines = [];
  const calls = [];
  const stripe = {
    customers: { create: async () => ({ id: 'cus_test' }) },
    invoices: {
      create: async (payload) => { calls.push(payload); invoice = { id: 'in_test', customer: 'cus_test', status: 'draft', total: 0 }; return { ...invoice }; },
      retrieve: async () => ({ ...invoice }),
      listLineItems: async () => ({ data: lines }),
      finalizeInvoice: async () => { invoice.status = 'open'; invoice.hosted_invoice_url = 'https://invoice.stripe.com/test'; return { ...invoice }; }
    },
    invoiceItems: { create: async (payload) => { assert.equal(payload.amount, 12500); assert.equal(payload.invoice, 'in_test'); lines.push(payload); invoice.total += payload.amount; } }
  };
  const args = { id: row.id, stripe, supabaseRest: async () => [{ ...row }],
    supabaseWrite: async (path, method, patch) => { row = { ...row, ...patch }; return [row]; } };
  return { args, calls, row: () => row, lines: () => lines };
}

test('creates exactly one $125 standalone invoice and reuses it on repeated requests', async () => {
  const f = fixture();
  const first = await createSponsorInvoice(f.args);
  const second = await createSponsorInvoice(f.args);
  assert.equal(first.id, second.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.lines().length, 1);
  assert.equal(f.calls[0].collection_method, 'send_invoice');
  assert.equal(f.calls[0].auto_advance, false);
  assert.equal(f.calls[0].subscription, undefined);
  assert.equal(f.calls[0].pending_invoice_items_behavior, 'exclude');
  assert.equal(f.row().status, 'invoiced');
});

test('rejects renewals, wrong amounts, check payments, and closed requests before contacting Stripe', async () => {
  for (const patch of [{ sponsorship_type: 'renewal' }, { amount_cents: 10000 },
    { payment_method: 'mail_check' }, { price_acknowledged: false },
    { status: 'paid' }, { status: 'complete' }, { status: 'canceled' }]) {
    const f = fixture(patch);
    await assert.rejects(createSponsorInvoice(f.args));
    assert.equal(f.calls.length, 0);
  }
});

test('blocks old uncertain attempts rather than risking a second invoice', async () => {
  const f = fixture({ invoice_started_at: '2020-01-01T00:00:00Z' });
  await assert.rejects(createSponsorInvoice(f.args), /earlier invoice attempt/);
  assert.equal(f.calls.length, 0);
});

test('resumes saved draft after line creation succeeds but finalization fails', async () => {
  const f = fixture();
  const finalize = f.args.stripe.invoices.finalizeInvoice;
  f.args.stripe.invoices.finalizeInvoice = async () => { throw new Error('temporary failure'); };
  await assert.rejects(createSponsorInvoice(f.args), /temporary failure/);
  f.args.stripe.invoices.finalizeInvoice = finalize;
  await createSponsorInvoice(f.args);
  assert.equal(f.calls.length, 1);
  assert.equal(f.lines().length, 1);
});

test('paid webhook updates only the matching sponsor invoice without changing completed requests', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const updates = [];
  const context = vm.createContext({
    require: (name) => name === 'stripe' ? () => ({}) : {},
    process: { env: {} }, module: { exports: {} },
    capture: async (path, payload) => updates.push({ path, payload })
  });
  vm.runInContext(fs.readFileSync(require.resolve('../api/stripe-webhook'), 'utf8') +
    '\nupdateSupabaseRows = capture;', context);
  await vm.runInContext(`handleInvoicePaid({ id: 'in_test', total: 12500,
    hosted_invoice_url: 'https://invoice.stripe.com/test',
    metadata: { rorc_sponsor_submission_id: 'sponsor-1' } })`, context);
  assert.equal(updates.length, 1);
  assert.match(updates[0].path, /stripe_invoice_id=eq.in_test/);
  assert.match(updates[0].path, /status=not.in.\(complete,canceled\)/);
  assert.equal(updates[0].payload.status, 'paid');
});
