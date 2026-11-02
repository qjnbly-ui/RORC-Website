const test=require('node:test');
const assert=require('node:assert/strict');
const {groupEventInvoiceComponents}=require('../api/_event-invoice-groups');
test('interleaved source charges stay together by event and keep their original amounts',()=>{
  const components=[{billing_line_item_id:'heat-b',rental_request_id:'b',amount_cents:400},{billing_line_item_id:'fee-a',amount_cents:200},{billing_line_item_id:'other',amount_cents:300},{billing_line_item_id:'heat-a',rental_request_id:'a',amount_cents:329},{billing_line_item_id:'fee-b',amount_cents:500}];
  const data={billing:[{id:'fee-a',rental_request_id:'a'},{id:'fee-b',rental_request_id:'b'}],rentals:[{id:'a',event_date:'2026-10-13',event_name:'Lunch',booking_number:'RORC-A'},{id:'b',event_date:'2026-10-20',event_name:'After school',booking_number:'RORC-B'}]};
  const result=groupEventInvoiceComponents(components,data);
  assert.deepEqual(result.map(c=>c.event_id),['a','a','b','b','']);
  assert.equal(result.reduce((n,c)=>n+c.amount_cents,0),1729);
  assert.match(result[0].event_label,/2026-10-13.*Lunch.*RORC-A/);
  assert.equal(result.length,components.length);
});
