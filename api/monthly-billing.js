const { previousMonth, validMonth, buildPreview, fail } = require('./_monthly-billing');
const BASE = (process.env.SUPABASE_URL || 'https://aedvuofiodtsgijcxyqx.supabase.co').replace(/\/+$/, '');
async function rest(path, options = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${BASE}/rest/v1/${path}`, { ...options, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) throw fail(502, `Could not load billing data (${response.status}).`);
  return response.status === 204 ? [] : response.json();
}
async function all(table, select = '*') {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await rest(`${table}?select=${select}&order=id.asc&limit=500&offset=${offset}`);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}
async function loadData() {
  const [members, billing, rentals, heaters, attendance, changes] = await Promise.all([
    all('account_members', 'id,account_id,member_name,email_address,is_billing_owner'),
    all('billing_line_items'), all('rental_requests'),
    all('heater_use_entries', 'id,used_on,start_at,end_at,paid,responsible_member_id,system_type'),
    all('timesheet_entries', 'id,signed_in_at'),
    all('rental_change_requests', 'id,rental_request_id,status')
  ]);
  return { members, billing, rentals, heaters, attendance, changes };
}
module.exports = async function monthlyBilling(req, res) {
  res.setHeader?.('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ success: false, error: 'Method not allowed' });
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw fail(503, 'Billing is not configured.');
    const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) throw fail(401, 'Please sign in.');
    const auth = await fetch(`${BASE}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
    if (!auth.ok) throw fail(401, 'Please sign in again.');
    const user = await auth.json();
    const manager = (await rest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(user.id)}&limit=1`))[0];
    if (manager?.account_type !== 'Account Manager') throw fail(403, 'Account manager access required.');
    const month = (req.method === 'GET' ? req.query?.month : req.body?.month) || previousMonth();
    if (!validMonth(month) || month > previousMonth()) throw fail(400, 'Choose a completed month to bill.');
    let data = await loadData();
    let preview = buildPreview(month, data);
    if (req.method === 'GET') return res.status(200).json({ success: true, ...preview });
    const action = req.body?.action;
    if (!['prepare', 'send'].includes(action)) throw fail(400, 'Choose prepare or send.');
    const group = preview.accounts.find(a => a.accountId === req.body?.accountId);
    if (!group) throw fail(404, 'No charges found for this account and month.');
    if (req.body?.fingerprint !== group.fingerprint) throw fail(409, 'Charges changed. Refresh and review this month before continuing.');
    if (group.issues.length) throw fail(409, group.issues.join(' '));
    if (action === 'prepare') {
      const { finalizeMonthlyRental } = require('./rental-reviews');
      const errors = [];
      let prepared = 0;
      for (const rental of group.unbilledRentals) {
        try {
          await finalizeMonthlyRental({ rental: data.rentals.find(r => r.id === rental.id), manager });
          prepared++;
        } catch (error) { errors.push(`${rental.reason} (${rental.date}): ${error.message}`); }
      }
      data = await loadData();
      preview = buildPreview(month, data);
      return res.status(200).json({ success: !errors.length, prepared, errors, ...preview });
    }
    if (group.unbilledRentals.length) throw fail(409, 'Prepare the rental charges before sending this invoice.');
    // One invoice per account/month; an existing invoice must be resumed or reviewed, never supplemented silently.
    const { sendMonthlyInvoice } = require('./create-stripe-invoice');
    const result = await sendMonthlyInvoice({ month, group, data, managerId: manager.id });
    return res.status(200).json({ success: true, invoice: result });
  } catch (error) {
    console.error('Monthly billing:', error.message);
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Could not update monthly billing.' });
  }
};
