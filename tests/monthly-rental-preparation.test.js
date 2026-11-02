const test=require('node:test');
const assert=require('node:assert/strict');
const {finalizeMonthlyRental}=require('../api/rental-reviews');
test('monthly rental preparation creates only the missing rental fee and is safe to repeat',async()=>{
 const original=global.fetch;
 const rental={id:'rental',claimed_member_id:'11111111-1111-4111-8111-111111111111',event_date:'2026-10-27',rental_status:'confirmed',estimated_total_cents:200,event_name:'Lunch recess'};
 const charges=[];const writes=[];
 global.fetch=async(url,options={})=>{
  const p=new URL(url);const table=p.pathname.split('/').pop();
  const json=data=>({ok:true,status:200,json:async()=>data,text:async()=>JSON.stringify(data)});
  if(!options.method){
   if(table==='rental_requests')return json([rental]);
   assert.equal(table,'billing_line_items');assert.equal(p.searchParams.get('heater_use_entry_id'),'is.null');return json(charges);
  }
  const body=JSON.parse(options.body);writes.push({table,method:options.method,body});
  if(table==='billing_line_items'){assert.equal(options.method,'POST');charges.push({id:'fee',...body});return json(charges);}
  assert.equal(table,'rental_requests');Object.assign(rental,body);return json([rental]);
 };
 try{
  await finalizeMonthlyRental({rental:{...rental},manager:{id:'manager'}});
  assert.equal(charges.length,1);assert.equal(charges[0].amount_cents,200);assert.equal(charges[0].rental_request_id,'rental');
  assert.equal(writes.length,2);
  await finalizeMonthlyRental({rental:{...rental},manager:{id:'manager'}});assert.equal(writes.length,2);
 }finally{global.fetch=original;}
});
test('individual Rentals still recognizes responsible members, shared participants, and requested add-ons',()=>{
 const {isThermostatCandidateForRental:matches}=require('../api/_rental-thermostat-candidates');
 const rental={id:'event',event_date:'2026-10-27',claimed_member_id:'member'};
 const heat={id:'heat',used_on:rental.event_date,responsible_member_id:'member'};
 assert.equal(matches(heat,rental),true);assert.equal(matches({...heat,responsible_member_id:'other'},rental),false);
 assert.equal(matches({...heat,responsible_member_id:'other'},rental,['member']),true);
 assert.equal(matches({...heat,responsible_member_id:'other'},{...rental,addon_heater:true}),true);
 assert.equal(matches({...heat,used_on:'2026-10-28'},rental),false);
});
