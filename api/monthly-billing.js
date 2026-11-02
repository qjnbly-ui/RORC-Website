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
    const page = await rest(`${table}?select=${select}&order=${table === 'rental_thermostat_links' ? 'rental_request_id.asc,heater_use_entry_id.asc' : table === 'heater_use_group_members' ? 'heater_use_entry_id.asc,account_member_id.asc' : 'id.asc'}&limit=500&offset=${offset}`);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}
async function loadData() {
  const [members, billing, rentals, heaters, attendance, changes, links, heaterGroupMembers] = await Promise.all([
    all('account_members', 'id,account_id,member_name,email_address,is_billing_owner'),
    all('billing_line_items'), all('rental_requests'),
    all('heater_use_entries', 'id,used_on,start_at,end_at,paid,responsible_member_id,system_type'),
    all('timesheet_entries', 'id,signed_in_at'),
    all('rental_change_requests', 'id,rental_request_id,status'),
    all('rental_thermostat_links', 'rental_request_id,heater_use_entry_id,ignored_at,created_at'),
    all('heater_use_group_members', 'heater_use_entry_id,account_member_id')
  ]);
  return { members, billing, rentals, heaters, attendance, changes, links, heaterGroupMembers };
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
    if (!['prepare', 'send', 'match', 'attach', 'separate'].includes(action)) throw fail(400, 'Choose prepare or send.');
    const group = preview.accounts.find(a => a.accountId === req.body?.accountId);
    if (!group) throw fail(404, 'No charges found for this account and month.');
    if (req.body?.fingerprint !== group.fingerprint) throw fail(409, 'Charges changed. Refresh and review this month before continuing.');
    if(action==='prepare' && group.issues.length) throw fail(409, group.issues.join(' '));
    let autoMatched=0;
    if (['prepare', 'match', 'attach', 'separate'].includes(action)) {
      const records = ['prepare','match'].includes(action) ? group.heaterMatches.filter(m=>m.status==='suggested' && !m.locked) : group.heaterMatches.filter(m=>m.heaterId===req.body?.heaterId);
      if (!records.length && action!=='prepare') throw fail(409, 'No eligible heater sessions were selected.');
      let matched=0;
      for(const record of records) {
        if(record.locked || record.foreignConflict) throw fail(409, 'This session has an invoice or conflicting attachments. Review it in Rentals before changing its event.');
        const target=action==='separate'?null:record.candidates.find(r=>r.id===(['prepare','match'].includes(action)?record.rental?.id:req.body?.rentalId));
        if(action!=='separate' && !target) throw fail(409, 'Select a confirmed rental for the same billing account and date.');
        if(target && data.changes.some(c=>c.rental_request_id===target.id&&c.status==='pending')) throw fail(409, 'Review the pending event change in Rentals before attaching heater use.');
        const rentalIds=[...new Set([...record.candidates.map(r=>r.id),...record.linkedRentalIds])];
        if(!rentalIds.length) throw fail(409, 'This session has no rental candidates.');
        // Record ignored alternatives so a deliberately separate charge stays reviewed.
        // No billing ownership, amounts, payment flags, or runtime records are changed.
        for(const rentalId of rentalIds) {
          await rest('rental_thermostat_links?on_conflict=rental_request_id,heater_use_entry_id', {
            method:'POST', headers:{Prefer:'resolution=merge-duplicates,return=representation'},
            body:JSON.stringify({rental_request_id:rentalId,heater_use_entry_id:record.heaterId,created_by_member_id:manager.id,ignored_at:rentalId===target?.id?null:new Date().toISOString()})
          });
        }
        matched++;
      }
      autoMatched=matched;
      if(action!=='prepare') return res.status(200).json({success:true,matched,...buildPreview(month,await loadData())});
    }
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
      return res.status(200).json({ success: !errors.length, prepared, matched:autoMatched, errors, ...preview });
    }
    if (group.heaterMatches.some(m=>m.needsReview)) throw fail(409, 'Match or review heater use before sending this invoice.');
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
