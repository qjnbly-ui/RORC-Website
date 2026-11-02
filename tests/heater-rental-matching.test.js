const test=require('node:test');
const assert=require('node:assert/strict');
const {buildPreview}=require('../api/_monthly-billing');
const fixture=()=>({
  members:[{id:'member',account_id:'account',member_name:'APCA',email_address:'a@example.test',is_billing_owner:true}],
  rentals:[{id:'lunch',claimed_member_id:'member',rental_status:'confirmed',event_date:'2026-10-27',event_name:'Lunch recess',event_start_time:'12:30',event_end_time:'13:00',estimated_total_cents:200}],
  billing:[{id:'charge',account_member_id:'member',heater_use_entry_id:'heat',amount_cents:329,created_at:'2026-10-27T20:00:00Z'}],
  heaters:[{id:'heat',used_on:'2026-10-27',start_at:'2026-10-27T19:48:00Z',end_at:'2026-10-27T20:03:00Z',responsible_member_id:'member'}],
  attendance:[],changes:[],links:[]
});
const group=data=>buildPreview('2026-10',data).accounts[0];
test('one same-account overlapping event is suggested in facility time',()=>{
  const match=group(fixture()).heaterMatches[0];assert.equal(match.status,'suggested');assert.equal(match.rental.id,'lunch');assert.equal(match.needsReview,true);
});
test('uses Rentals suggestions outside event hours and requires review when several events match',()=>{
  const data=fixture();data.heaters[0].start_at='2026-10-27T22:00:00Z';data.heaters[0].end_at='2026-10-27T22:30:00Z';
  assert.equal(group(data).heaterMatches[0].status,'suggested');
  data.heaters=fixture().heaters;data.rentals.push({...data.rentals[0],id:'other'});
  assert.equal(group(data).heaterMatches[0].status,'review');
});
test('matching never crosses account boundaries even for identical dates and times',()=>{
  const data=fixture();data.members.push({id:'other',account_id:'other-account'});data.rentals[0].claimed_member_id='other';
  const match=group(data).heaterMatches[0];assert.equal(match.status,'standalone');assert.equal(match.candidates.length,0);
});
test('existing links are preserved and reflected in charge descriptions without changing totals',()=>{
  const data=fixture();data.links=[{rental_request_id:'lunch',heater_use_entry_id:'heat',ignored_at:null}];
  const result=group(data);assert.equal(result.heaterMatches[0].status,'attached');assert.equal(result.readyCents,329);assert.match(result.items[0].eventLabel,/Lunch recess/);assert.equal(result.items.length,1);
});
test('ignored suggestions stay separate and are not attached again',()=>{
  const data=fixture();data.links=[{rental_request_id:'lunch',heater_use_entry_id:'heat',ignored_at:'2026-11-01T12:00:00Z'}];
  assert.equal(group(data).heaterMatches[0].status,'separate');assert.equal(group(data).heaterMatches[0].needsReview,false);
});
test('duplicate and invalid existing attachments are flagged instead of silently changed',()=>{
  const data=fixture();data.rentals.push({...data.rentals[0],id:'other'});data.links=data.rentals.map(r=>({rental_request_id:r.id,heater_use_entry_id:'heat'}));
  assert.equal(group(data).heaterMatches[0].status,'conflict');assert.equal(group(data).heaterMatches[0].needsReview,true);
});
test('an invoiced heater charge is locked against event reassignment',()=>{
  const data=fixture();data.billing[0].stripe_invoice_id='in_existing';data.billing[0].stripe_invoice_status='open';
  assert.equal(group(data).heaterMatches[0].locked,true);assert.equal(group(data).heaterMatches[0].needsReview,false);
});
test('event changes invalidate the monthly review fingerprint',()=>{
  const data=fixture(), before=group(data).fingerprint;data.rentals[0].event_start_time='15:00';assert.notEqual(group(data).fingerprint,before);
});
test('shared heater participants and requested heater add-ons follow the same Rentals candidate rules',()=>{
  const data=fixture();data.heaters[0].responsible_member_id='someone-else';
  assert.equal(group(data).heaterMatches[0].status,'review');
  data.heaterGroupMembers=[{heater_use_entry_id:'heat',account_member_id:'member'}];
  assert.equal(group(data).heaterMatches[0].status,'suggested');
  data.heaterGroupMembers=[];data.rentals[0].addon_heater=true;
  assert.equal(group(data).heaterMatches[0].status,'suggested');
  data.heaters[0].system_type='ac';
  assert.equal(group(data).heaterMatches[0].status,'review');
});
test('event summary combines heater charges with their single recognized rental without inflating account totals',()=>{
  const data=fixture();const result=group(data);
  assert.equal(result.events[0].rentalCents,200);assert.equal(result.events[0].heaterCents,329);assert.equal(result.events[0].totalCents,529);assert.equal(result.events[0].pendingAttachment,true);
  assert.equal(result.readyCents+result.rentalCents,529);
});
