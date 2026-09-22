import Stripe from 'stripe';
import type { Request, Response } from 'express';
import { calculateLine, finishPreview, overlaps, priceId, validateDates, type Closure, type Line, type Preview } from './calculation';

type Row = { id: string; account_id: string; customer_id: string | null; state: string; amount_cents: number; fingerprint: string; stripe_transaction_id: string | null };
const base = (process.env.SUPABASE_URL || 'https://aedvuofiodtsgijcxyqx.supabase.co').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
function error(status: number, message: string) { return Object.assign(new Error(message), { status }); }
const headers = () => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
async function rest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/rest/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) {
    if (data.code === 'PGRST205' || data.code === 'PGRST202' || data.code === '42P01') throw error(503, 'Closure credits need the database migration before they can be used.');
    if (data.code === '23505') throw error(409, 'Duplicate Stripe customer mapping or adjustment. Review the account billing links.');
    throw error(409, data.message || 'Could not save closure credit.');
  }
  return data as T;
}
async function allRows<T>(path: string): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await rest<T[]>(`${path}&limit=500&offset=${offset}`);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}
async function rpc(action: string, id: string | null, data: unknown = {}): Promise<any> {
  return rest('rpc/manage_facility_closure_credit', { p_action: action, p_id: id, p_data: data });
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw error(400, 'Invalid record ID.');
  return value;
}
async function manager(req: Request): Promise<string> {
  const token = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw error(401, 'Please sign in again.');
  const response = await fetch(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!response.ok) throw error(401, 'Please sign in again.');
  const user = await response.json();
  const members = await rest<Array<{ id: string; account_type: string }>>(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  if (members[0]?.account_type !== 'Account Manager') throw error(403, 'Only account managers can manage closure credits.');
  return members[0].id;
}
function plans(): Map<string, string> {
  const entries = [
    ['STRIPE_PRICE_WEIGHT_ROOM_MONTHLY', 'Weight Room'],
    ['STRIPE_PRICE_FULL_FACILITY_MONTHLY', 'Full Facility'],
    ['STRIPE_PRICE_FULL_FACILITY_WIFI_MONTHLY', 'Full Facility + Wi-Fi']
  ];
  return new Map(entries.map(([name, label]) => {
    const id = process.env[name!] || '';
    if (!id) throw error(503, `Missing paid membership price configuration: ${name}.`);
    return [id, label!] as const;
  }));
}
async function invoiceHasRefund(stripe: Stripe, invoice: Stripe.Invoice): Promise<boolean> {
  if (invoice.pre_payment_credit_notes_amount || invoice.post_payment_credit_notes_amount) return true;
  // Invoice Payments is used by the pinned Stripe SDK; also check older invoice fields.
  const payments = stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 100 });
  for await (const payment of payments) {
    const pi = payment.payment.payment_intent;
    const charge = payment.payment.charge;
    if (pi) {
      const id = typeof pi === 'string' ? pi : pi.id;
      for await (const refund of stripe.refunds.list({ payment_intent: id, limit: 100 })) {
        if (refund.status !== 'failed' && refund.status !== 'canceled') return true;
      }
      const intent = await stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
      if (typeof intent.latest_charge === 'object' && intent.latest_charge?.disputed) return true;
    } else if (charge) {
      const data = typeof charge === 'string' ? await stripe.charges.retrieve(charge) : charge;
      if (data.amount_refunded > 0 || data.disputed) return true;
    } else if (payment.payment.type === 'payment_record') {
      throw new Error('External payment record requires manual review.');
    }
  }
  const legacy = invoice as unknown as { charge?: string };
  if (legacy.charge) {
    const charge = await stripe.charges.retrieve(legacy.charge);
    if (charge.amount_refunded || charge.disputed) return true;
  }
  return false;
}
export async function previewAccount(stripe: Stripe, customer: string, closure: Closure): Promise<Preview> {
  const allowed = plans();
  const details: Preview['details'] = [];
  const warnings: string[] = [];
  let count = 0;
  for await (const invoice of stripe.invoices.list({ customer, limit: 100 })) {
    if (++count > 1000) throw error(409, 'Large invoice history requires manual review. No partial preview was saved.');
    if (invoice.status === 'draft' || invoice.status === 'void') continue;
    const eligible: Line[] = [];
    const invoiceLines = invoice.lines.has_more ? stripe.invoices.listLineItems(invoice.id, { limit: 100 }) : invoice.lines.data;
    for await (const item of invoiceLines) {
      const line = item as unknown as Line;
      if (!overlaps(line, closure)) continue;
      if (!line.parent?.subscription_item_details && line.type !== 'subscription') continue;
      if (!allowed.has(priceId(line))) {
        if (line.amount > 0 && priceId(line) !== process.env.STRIPE_PRICE_OPEN_GYM_MONTHLY) warnings.push(`${invoice.id}: unrecognized paid subscription price requires manual review.`);
        continue;
      }
      eligible.push(line);
    }
    if (!eligible.length) continue;
    if (invoice.status !== 'paid') { warnings.push(`${invoice.id}: membership invoice is not paid. Resolve it separately.`); continue; }
    if (eligible.every(line => line.amount === 0 || line.amount === (line.discount_amounts || []).reduce((n, d) => n + d.amount, 0))) continue;
    try {
      if (await invoiceHasRefund(stripe, invoice)) { warnings.push(`${invoice.id}: refund, dispute, or credit note needs review.`); continue; }
      for (const line of eligible) {
        const detail = calculateLine(line, invoice.id, allowed.get(priceId(line))!, closure);
        if (detail) details.push(detail);
      }
    } catch (caught) {
      // Stripe/network errors abort the preview instead of silently excluding paid time.
      if (caught instanceof Error && (caught.message.includes('requires manual review') || caught.message.includes('require manual review'))) warnings.push(`${invoice.id}: ${caught.message}`);
      else throw caught;
    }
  }
  // Overlapping paid periods can indicate a duplicate subscription or plan change.
  const sorted = [...details].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  if (sorted.some((d, i) => i > 0 && d.periodStart < sorted[i - 1]!.periodEnd)) warnings.push('Overlapping membership billing periods require manual review.');
  if (details.some(d => d.creditCents > 0)) {
    let active = false;
    for await (const subscription of stripe.subscriptions.list({ customer, status: 'all', limit: 100 })) {
      if (['active', 'trialing'].includes(subscription.status) && !subscription.cancel_at_period_end && !subscription.cancel_at && subscription.items.data.some(item => allowed.has(item.price.id))) active = true;
    }
    if (!active) warnings.push('No continuing paid gym subscription. Review a refund instead of leaving an unused credit.');
  }
  return finishPreview(details, warnings);
}
export async function applyAccount(stripe: Stripe, closure: Closure, row: Row): Promise<string> {
  if (!row.customer_id) throw error(409, 'This account has no linked Stripe customer.');
  // Recover a completed Stripe write even if saving its ID failed, including retries
  // beyond Stripe's idempotency retention window. Read all pages, never just the first.
  for await (const transaction of stripe.customers.listBalanceTransactions(row.customer_id, { limit: 100 })) {
    if (transaction.metadata?.rorc_closure_credit_id === row.id) {
      if (transaction.amount !== -row.amount_cents || transaction.currency !== 'usd') throw error(409, 'Existing credit does not match the approved amount. Review in Stripe.');
      return transaction.id;
    }
  }
  const current = await previewAccount(stripe, row.customer_id, closure);
  if (current.warnings.length || current.fingerprint !== row.fingerprint) {
    await rpc('review', closure.id, { row_id: row.id, note: 'Billing changed since preview. No credit was issued. Exclude this account and resolve it separately.' });
    throw error(409, 'Billing changed since preview. This account now needs review.');
  }
  const transaction = await stripe.customers.createBalanceTransaction(row.customer_id, {
    amount: -row.amount_cents, currency: 'usd',
    description: `RORC gym closure credit: ${closure.starts_on} through day before ${closure.reopens_on}`,
    metadata: { rorc_closure_credit_id: row.id, rorc_closure_id: closure.id, rorc_account_id: row.account_id }
  }, { idempotencyKey: `rorc-closure-credit-${row.id}` });
  return transaction.id;
}
async function handler(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    if (!key || !process.env.STRIPE_SECRET_KEY) throw error(503, 'Billing service is not configured.');
    const managerId = await manager(req);
    const body = req.body || {};
    const action = String(body.action || 'list');
    if (action === 'list') {
      res.json({ closures: await allRows<Closure>('facility_closure_credits?select=*&order=created_at.desc,id') }); return;
    }
    if (action === 'create') {
      plans();
      const start = String(body.starts_on || ''); const end = String(body.reopens_on || '');
      try { validateDates(start, end); } catch (e) { throw error(400, (e as Error).message); }
      const reason = String(body.reason || '').trim();
      if (!reason || reason.length > 200) throw error(400, 'Enter a reason of up to 200 characters.');
      const closure = await rpc('create', null, { starts_on: start, reopens_on: end, reason, manager_id: managerId });
      res.json({ closure }); return;
    }
    const id = uuid(body.closure_id);
    const closure = (await rest<Closure[]>(`facility_closure_credits?select=*&id=eq.${id}`))[0];
    if (!closure) throw error(404, 'Closure not found.');
    if (action === 'get') {
      res.json({ closure, rows: await allRows<Row>(`facility_closure_credit_accounts?select=*&closure_id=eq.${id}&order=account_label,id`) }); return;
    }
    if (action === 'cancel') { await rpc('cancel', id); res.json({ success: true }); return; }
    if (action === 'begin') {
      if (body.reviewed_refunds !== true) throw error(400, 'Confirm that prior refunds and credits have been reviewed.');
      await rpc('begin', id, { manager_id: managerId, expected_rows: body.expected_rows }); res.json({ success: true }); return;
    }
    const rowId = uuid(body.row_id);
    if (action === 'exclude') {
      await rpc('exclude', id, { row_id: rowId, note: String(body.note || '').trim() }); res.json({ success: true }); return;
    }
    const row = (await rest<Row[]>(`facility_closure_credit_accounts?select=*&id=eq.${rowId}&closure_id=eq.${id}`))[0];
    if (!row) throw error(404, 'Account adjustment not found.');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { timeout: 20000, maxNetworkRetries: 1 });
    if (action === 'preview') {
      if (closure.status !== 'draft') throw error(409, 'This preview is locked.');
      const preview = row.customer_id
        ? await previewAccount(stripe, row.customer_id, closure)
        : finishPreview([], ['No linked Stripe customer. Verify this account’s billing setup and handle its credit separately.']);
      await rpc('preview', id, { row_id: rowId, preview }); res.json({ success: true }); return;
    }
    if (action === 'apply') {
      if (row.state === 'applied') { res.json({ success: true }); return; }
      const claimed = await rpc('claim', id, { row_id: rowId }) as Row;
      if (claimed.state !== 'applied') {
        const transactionId = await applyAccount(stripe, closure, claimed);
        await rpc('finish', id, { row_id: rowId, transaction_id: transactionId });
      }
      res.json({ success: true }); return;
    }
    throw error(400, 'Unknown action.');
  } catch (caught) {
    const e = caught as Error & { status?: number };
    console.error('Closure credit request failed:', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not complete the request. Refresh to check saved progress, then retry. No duplicate credit will be created.' });
  }
}
export default handler;
