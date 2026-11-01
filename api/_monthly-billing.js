const crypto = require('node:crypto');
const ZONE = 'America/Los_Angeles';
function fail(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function previousMonth(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(today.find(p => p.type === 'year').value);
  const month = Number(today.find(p => p.type === 'month').value);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}
function validMonth(month) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || '')); }
function dateKey(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('-');
}
function paid(item) { return item.stripe_invoice_id ? item.stripe_invoice_status === 'paid' : Boolean(item.posted_to_stripe_at); }
function active(item) { return Boolean(item.stripe_invoice_id) && !['void', 'paid'].includes(item.stripe_invoice_status); }
function fingerprint(group) {
  return crypto.createHash('sha256').update(JSON.stringify({
    accountId: group.accountId, name: group.name, email: group.email,
    items: group.items.map(i => [i.id, i.amountCents, i.date, i.status, i.reason, i.invoiceId, i.deliveryPending]).sort(),
    rentals: group.unbilledRentals.map(r => [r.id, r.amountCents, r.memberId]).sort(),
    issues: group.issues.slice().sort()
  })).digest('hex');
}
function buildPreview(month, data) {
  if (!validMonth(month)) throw fail(400, 'Choose a valid billing month.');
  const members = new Map(data.members.map(row => [row.id, row]));
  const rentals = new Map(data.rentals.map(row => [row.id, row]));
  const heaters = new Map(data.heaters.map(row => [row.id, row]));
  const attendance = new Map(data.attendance.map(row => [row.id, row]));
  const groups = new Map();
  const issues = [];
  function groupFor(memberId) {
    const member = members.get(memberId);
    if (!member?.account_id) return null;
    if (!groups.has(member.account_id)) {
      const owners = data.members.filter(m => m.account_id === member.account_id);
      const owner = owners.find(m => m.is_billing_owner) || member;
      groups.set(member.account_id, { accountId: member.account_id, name: owner.member_name || 'Unnamed account', email: owner.email_address || '', items: [], unbilledRentals: [], issues: [] });
    }
    return groups.get(member.account_id);
  }
  for (const item of data.billing) {
    const heater = heaters.get(item.heater_use_entry_id);
    const rental = rentals.get(item.rental_request_id);
    const date = dateKey(heater?.used_on || rental?.event_date || attendance.get(item.timesheet_entry_id)?.signed_in_at || item.created_at);
    if (!date.startsWith(month)) continue;
    const group = groupFor(item.account_member_id);
    if (!group) { issues.push(`Unassigned charge: ${item.reason || item.id}`); continue; }
    const status = paid(item) ? 'paid' : active(item) ? 'invoiced' : 'ready';
    group.items.push({ id: item.id, date, amountCents: Number(item.amount_cents || 0), reason: item.reason || 'Charge', source: item.heater_use_entry_id ? 'Heater / AC' : item.rental_request_id ? 'Rental' : item.timesheet_entry_id ? 'Guest' : 'Other', status, invoiceId: item.stripe_invoice_id || '', invoiceStatus: item.stripe_invoice_status || '', deliveryPending: item.payment_note === 'Monthly invoice delivery pending', invoiceUrl: item.stripe_invoice_url || '', memberId: item.account_member_id });
    if (item.rental_request_id && !rental) group.issues.push('A rental charge is missing its source event.');
    if (rental && ['canceled', 'rejected'].includes(rental.rental_status) && status === 'ready') group.issues.push(`Review charge for canceled or rejected event: ${rental.event_name || rental.id}`);
    if (item.heater_use_entry_id && !heater) group.issues.push('A heater charge is missing its runtime record.');
    if (status === 'ready' && !Number.isSafeInteger(Number(item.amount_cents))) group.issues.push('A charge has an invalid amount.');
  }
  for (const rental of data.rentals) {
    if (!String(rental.event_date).startsWith(month) || rental.rental_status !== 'confirmed') continue;
    if (data.billing.some(b => b.rental_request_id === rental.id && !b.heater_use_entry_id)) continue;
    if (rental.payment_status === 'paid') { issues.push(`Paid rental has no billing record: ${rental.event_name || rental.id}`); continue; }
    const group = groupFor(rental.claimed_member_id);
    if (!group) { issues.push(`Attach an account to ${rental.event_name || 'Rental'} (${rental.event_date}) in Rentals.`); continue; }
    if (rental.claimed_account_id && rental.claimed_account_id !== group.accountId) group.issues.push(`Rental account does not match its billing contact: ${rental.event_name || rental.id}`);
    const amountCents = Number(rental.estimated_total_cents || 0);
    if (amountCents === 0) continue;
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) { group.issues.push(`Review rental amount: ${rental.event_name || rental.id}`); continue; }
    group.unbilledRentals.push({ id: rental.id, memberId: rental.claimed_member_id, date: rental.event_date, reason: rental.event_name || rental.event_type || 'Rental', amountCents });
  }
  for (const heater of data.heaters) {
    if (!String(heater.used_on).startsWith(month) || heater.paid) continue;
    // An immediate on/off record has no usage and legitimately has no charge.
    if (heater.end_at && heater.start_at && Date.parse(heater.end_at) <= Date.parse(heater.start_at)) continue;
    const group = groupFor(heater.responsible_member_id);
    const message = !heater.end_at ? `Heater use is still running on ${heater.used_on}.` : !data.billing.some(b => b.heater_use_entry_id === heater.id) ? `Heater use on ${heater.used_on} has no billing charge. Review it in Thermostat.` : '';
    if (message) (group ? group.issues : issues).push(message);
  }
  for (const change of data.changes || []) {
    const rental = rentals.get(change.rental_request_id);
    if (change.status !== 'pending' || !rental?.event_date?.startsWith(month)) continue;
    const group = groupFor(rental.claimed_member_id);
    (group ? group.issues : issues).push(`Review a pending rental change for ${rental.event_name || rental.id} before billing.`);
  }
  const accounts = [...groups.values()].map(group => {
    group.items.sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    group.unbilledRentals.sort((a,b) => a.date.localeCompare(b.date));
    group.readyCents = group.items.filter(i => i.status === 'ready').reduce((n,i) => n+i.amountCents,0);
    group.rentalCents = group.unbilledRentals.reduce((n,r) => n+r.amountCents,0);
    group.invoiceIds = [...new Set(group.items.filter(i => i.status !== 'ready').map(i => i.invoiceId).filter(Boolean))];
    if (!group.email) group.issues.push('Add a billing email to this account before sending.');
    group.fingerprint = fingerprint(group);
    return group;
  }).sort((a,b) => a.name.localeCompare(b.name));
  return { month, accounts, issues };
}
module.exports = { previousMonth, validMonth, dateKey, buildPreview, fail, paid, active };
