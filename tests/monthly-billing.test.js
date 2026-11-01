const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPreview, previousMonth, dateKey } = require('../api/_monthly-billing');
const fixture = () => ({
  members: [
    {id:'apca',account_id:'account-apca',member_name:'APCA',email_address:'apca@example.test',is_billing_owner:true},
    {id:'kbyd',account_id:'account-kbyd',member_name:'KBYD',email_address:'kbyd@example.test',is_billing_owner:true},
    {id:'other-apca',account_id:'account-apca',member_name:'APCA helper'}
  ],
  rentals: [
    {id:'r-apca',claimed_member_id:'apca',event_name:'Lunch recess',event_date:'2026-10-13',rental_status:'confirmed',estimated_total_cents:200},
    {id:'r-kbyd',claimed_member_id:'kbyd',event_name:'After school',event_date:'2026-10-14',rental_status:'confirmed',estimated_total_cents:2000}
  ],
  billing: [{id:'heat-charge',account_member_id:'other-apca',heater_use_entry_id:'heat',amount_cents:1647,reason:'Heat',created_at:'2026-11-01T18:00:00Z'}],
  heaters:[{id:'heat',used_on:'2026-10-30',responsible_member_id:'apca',end_at:'2026-10-30T20:00:00Z'}],
  attendance:[],changes:[]
});
test('previous month uses facility timezone and handles January rollover',()=>{
  assert.equal(previousMonth(new Date('2026-11-01T18:00:00Z')),'2026-10');
  assert.equal(previousMonth(new Date('2027-01-01T18:00:00Z')),'2026-12');
  assert.equal(previousMonth(new Date('2026-11-01T01:00:00Z')),'2026-09');
  assert.equal(dateKey('2026-10-01T01:00:00Z'),'2026-09-30');
});
test('combines same-account contacts, separates APCA and KBYD, and includes late-created October usage',()=>{
  const preview=buildPreview('2026-10',fixture());
  assert.equal(preview.accounts.length,2);
  assert.equal(preview.accounts[0].name,'APCA');
  assert.equal(preview.accounts[0].readyCents+preview.accounts[0].rentalCents,1847);
  assert.equal(preview.accounts[1].readyCents+preview.accounts[1].rentalCents,2000);
  assert.equal(preview.accounts[0].items[0].date,'2026-10-30');
  assert.equal(preview.accounts[0].issues.length,0);
});
test('rental event date takes priority over charge date and existing bills are not prepared twice',()=>{
  const data=fixture();data.billing.push({id:'r-fee',account_member_id:'apca',rental_request_id:'r-apca',amount_cents:200,created_at:'2026-11-01T18:00:00Z'});
  const group=buildPreview('2026-10',data).accounts[0];
  assert.equal(group.unbilledRentals.length,0);
  assert.equal(group.readyCents,1847);
});
test('guest and manual charges honor facility month boundaries',()=>{
  const data=fixture(); data.attendance.push({id:'visit',signed_in_at:'2026-11-01T02:00:00Z'});
  data.billing.push({id:'guest',account_member_id:'apca',timesheet_entry_id:'visit',amount_cents:500,created_at:'2026-11-02T12:00:00Z'}, {id:'nov',account_member_id:'apca',amount_cents:900,created_at:'2026-11-01T18:00:00Z'});
  assert.deepEqual(buildPreview('2026-10',data).accounts[0].items.map(i=>i.id),['heat-charge','guest']);
});
test('paid and invoiced charges stay visible but are excluded from new totals',()=>{
  const data=fixture(); data.billing[0].stripe_invoice_id='in_existing';data.billing[0].stripe_invoice_status='open';data.billing[0].posted_to_stripe_at='2026-11-01';
  const group=buildPreview('2026-10',data).accounts[0];
  assert.equal(group.items[0].status,'invoiced');assert.equal(group.readyCents,0);
  assert.deepEqual(group.invoiceIds,['in_existing']);
  data.billing[0].stripe_invoice_status='paid';
  assert.equal(buildPreview('2026-10',data).accounts[0].items[0].status,'paid');
});
test('unassigned rentals, missing heater charges, pending changes, and running heat are flagged',()=>{
  const data=fixture();data.rentals[0].claimed_member_id=null;data.billing=[];
  data.heaters[0].end_at=null;data.changes=[{rental_request_id:'r-kbyd',status:'pending'}];
  const preview=buildPreview('2026-10',data);
  assert.match(preview.issues.join(' '),/Attach an account/);
  assert.match(preview.accounts.find(a=>a.name==='APCA').issues.join(' '),/still running/);
  assert.match(preview.accounts.find(a=>a.name==='KBYD').issues.join(' '),/pending rental change/);
});
test('review fingerprint changes after edits but not input ordering',()=>{
  const data=fixture();const before=buildPreview('2026-10',data).accounts[0].fingerprint;
  data.members.reverse();assert.equal(buildPreview('2026-10',data).accounts[0].fingerprint,before);
  data.billing[0].amount_cents++;assert.notEqual(buildPreview('2026-10',data).accounts[0].fingerprint,before);
});
test('same names in separate accounts are never silently merged',()=>{
  const data=fixture();data.members[1].member_name='APCA';
  assert.equal(buildPreview('2026-10',data).accounts.length,2);
});
test('invalid months are rejected',()=>{
  for(const month of ['2026-00','2026-13','2026-1','junk']) assert.throws(()=>buildPreview(month,fixture()),/valid billing month/);
});
test('zero-runtime thermostat records do not block billing or invent a charge',()=>{
  const data=fixture();data.heaters.push({id:'zero',used_on:'2026-10-29',responsible_member_id:'apca',start_at:'2026-10-29T23:36:12Z',end_at:'2026-10-29T23:36:12Z'});
  assert.equal(buildPreview('2026-10',data).accounts[0].issues.length,0);
});
test('a heater linked to a rental still uses its runtime date and is not mistaken for the rental fee',()=>{
  const data=fixture();data.billing[0].rental_request_id='r-apca';data.heaters[0].used_on='2026-09-30';
  const group=buildPreview('2026-10',data).accounts.find(a=>a.name==='APCA');
  assert.equal(group.items.length,0);assert.equal(group.unbilledRentals.length,1);
});
