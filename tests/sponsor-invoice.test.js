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
  const sends = [];
  const stripe = {
    customers: { create: async () => ({ id: 'cus_test' }) },
    invoices: {
      create: async (payload) => { calls.push(payload); invoice = { id: 'in_test', customer: 'cus_test', status: 'draft', total: 0, currency: 'usd', customer_email: row.email_address }; return { ...invoice }; },
      retrieve: async () => ({ ...invoice }),
      sendInvoice: async (id, payload, options) => { sends.push({ id, options }); return { ...invoice }; },
      listLineItems: async () => ({ data: lines }),
      finalizeInvoice: async () => { invoice.status = 'open'; invoice.hosted_invoice_url = 'https://invoice.stripe.com/test'; return { ...invoice }; }
    },
    invoiceItems: { create: async (payload) => { assert.equal(payload.amount, 12500); assert.equal(payload.invoice, 'in_test'); lines.push(payload); invoice.total += payload.amount; } }
  };
  const args = { id: row.id, stripe, supabaseRest: async () => [{ ...row }],
    supabaseWrite: async (path, method, patch) => { row = { ...row, ...patch }; return [row]; } };
  return { args, calls, sends, row: () => row, lines: () => lines };
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

test('rejects renewals, wrong amounts, unacknowledged pricing, and closed requests before contacting Stripe', async () => {
  for (const patch of [{ sponsorship_type: 'renewal' }, { amount_cents: 10000 },
    { price_acknowledged: false },
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


test('sending creates a single invoice, emails it once, and records the sent date', async () => {
  const f = fixture();
  const first = await createSponsorInvoice({ ...f.args, mode: 'send' });
  const second = await createSponsorInvoice({ ...f.args, mode: 'send' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(first.id, second.id);
  assert.ok(first.sentAt);
  assert.equal(second.alreadySent, true);
  assert.equal(f.row().stripe_invoice_sent_at, first.sentAt);
});

test('creation and refresh do not email; sending reuses the prepared invoice', async () => {
  const f = fixture();
  await createSponsorInvoice(f.args);
  await createSponsorInvoice(f.args);
  assert.equal(f.sends.length, 0);
  await createSponsorInvoice({ ...f.args, mode: 'send' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.sends[0].id, 'in_test');
});

test('failed email send can be retried without creating another invoice', async () => {
  const f = fixture();
  const send = f.args.stripe.invoices.sendInvoice;
  f.args.stripe.invoices.sendInvoice = async () => { throw new Error('Email unavailable'); };
  await assert.rejects(createSponsorInvoice({ ...f.args, mode: 'send' }), /Email unavailable/);
  assert.equal(f.row().stripe_invoice_sent_at, undefined);
  f.args.stripe.invoices.sendInvoice = send;
  await createSponsorInvoice({ ...f.args, mode: 'send' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.sends.length, 1);
});

test('does not send paid, changed-amount, or mismatched-recipient invoices', async () => {
  for (const patch of [{ status: 'paid' }, { total: 13000 }, { customer_email: 'different@example.test' }]) {
    const f = fixture();
    await createSponsorInvoice(f.args);
    const retrieve = f.args.stripe.invoices.retrieve;
    f.args.stripe.invoices.retrieve = async () => ({ ...await retrieve(), ...patch });
    await assert.rejects(createSponsorInvoice({ ...f.args, mode: 'send' }));
    assert.equal(f.sends.length, 0);
  }
});

function uiFixture(confirmed) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../RORC App/app.js'), 'utf8');
  const result = { textContent: '' };
  const requests = [];
  const dialogs = [];
  const submission = { id: 'sponsor-1', businessName: '<Test Sponsor>', emailAddress: 'sponsor@example.test' };
  const context = vm.createContext({
    sponsorSubmissions: [submission], document: { getElementById: () => result },
    escapeHtml: (s) => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    openLinkedDeleteDialog: async (options) => { dialogs.push(options); return confirmed; },
    postSponsorSubmissionAction: async (payload) => { requests.push(payload); return { invoice: { sentAt: 'today' } }; },
    fetchSponsorSubmissions: async () => [submission], updateSponsorSubmissionsBadge: () => {}, renderSponsorSubmissionList: () => {}
  });
  vm.runInContext(source.slice(source.indexOf('function buildSponsorInvoiceConfirmationDetailHtml('), source.indexOf('function bindSponsorSubmissionActions()')), context);
  return { context, requests, dialogs, result };
}

test('canceling the rental-style banner preview makes no invoice or email request', async () => {
  const f = uiFixture(false);
  const button = { disabled: false };
  await f.context.createSponsorBannerInvoice('sponsor-1', button, 'send');
  assert.equal(f.requests.length, 0);
  assert.equal(button.disabled, false);
  assert.match(f.dialogs[0].detailHtml, /sponsor@example.test/);
  assert.match(f.dialogs[0].detailHtml, /\$125.00/);
  assert.match(f.dialogs[0].detailHtml, /No automatic renewal/);
  assert.match(f.dialogs[0].detailHtml, /&lt;Test Sponsor&gt;/);
});

test('confirming the preview requests sending and displays the recipient', async () => {
  const f = uiFixture(true);
  await f.context.createSponsorBannerInvoice('sponsor-1', { disabled: false }, 'send');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].mode, 'send');
  assert.equal(f.requests[0].id, 'sponsor-1');
  assert.match(f.result.textContent, /Invoice sent to sponsor@example.test/);
});


test('a sponsor who originally chose check can be invoiced and emailed without duplicate invoices', async () => {
  const f = fixture({ payment_method: 'mail_check' });
  const draft = await createSponsorInvoice(f.args);
  const sent = await createSponsorInvoice({ ...f.args, mode: 'send' });
  await createSponsorInvoice({ ...f.args, mode: 'send' });
  assert.equal(draft.id, sent.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.lines()[0].amount, 12500);
  assert.equal(f.row().payment_method, 'mail_check');
  assert.equal(f.row().status, 'invoiced');
});

test('the banner card offers invoice actions for the original check preference', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../RORC App/app.js'), 'utf8');
  const context = vm.createContext({
    escapeHtml: String, escapeAttribute: String, formatShortDateTime: () => 'Today',
    sponsorStatusClass: () => 'pending', sponsorStatusLabel: String,
    formatCurrency: () => '$125.00', emailHref: () => 'mailto:test@example.test'
  });
  vm.runInContext(source.slice(source.indexOf('function renderSponsorSubmissionCard('), source.indexOf('function buildSponsorInvoiceConfirmationDetailHtml(')), context);
  const card = context.renderSponsorSubmissionCard({ id: 'test', sponsorshipType: 'new', amountCents: 12500,
    paymentMethod: 'mail_check', priceAcknowledged: true, status: 'in_review' });
  assert.match(card, /data-sponsor-send-invoice="test"/);
  assert.match(card, /data-sponsor-invoice="test"/);
  assert.match(card, /Originally selected: Mail a check/);
});
