const test=require('node:test');
const assert=require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-service-only';
const handler=require('../api/recurring-rentals');
const id='11111111-1111-4111-8111-111111111111';
function invoke(body,authorization='Bearer fixture-session') {
 const res={code:0,status(code){this.code=code;return this;},json(value){this.body=value;return this;}};
 return handler({method:'POST',headers:{authorization},body},res).then(()=>res);
}
test('authenticated manager maps stable validated rows into service RPC without trusting client prices',async()=>{
 const original=global.fetch; const calls=[];
 global.fetch=async(url,options)=>{calls.push({url,options}); const data=String(url).includes('/auth/')?{id}:String(url).includes('account_members?')?[{id,account_type:'Account Manager'}]:{success:true,rentalIds:[id]}; return {ok:true,json:async()=>data};};
 try {
  const body={operationId:id,action:'create',rentals:[{event_date:'2026-10-06',event_start_time:'10:00',event_end_time:'11:00',rental_type:'hourly',estimated_total_cents:1}]};
  const first=await invoke(body); assert.equal(first.code,200);
  await invoke(body);
  const commands=calls.filter(v=>v.url.includes('/rpc/')).map(v=>JSON.parse(v.options.body));
  assert.deepEqual(commands[0],commands[1]); assert.equal(commands[0].actor_id,id);
  assert.equal(commands[0].command.rentals[0].estimated_total_cents,1000);
  assert.equal(commands[0].command.rentals[0].reviewed_at,undefined);
 } finally {global.fetch=original;}
});
test('missing auth and non-manager create never reach the mutation RPC',async()=>{
 assert.equal((await invoke({},'')).code,401);
 const original=global.fetch;let mutations=0;
 global.fetch=async(url)=>{if(String(url).includes('/rpc/'))mutations++;return {ok:true,json:async()=>String(url).includes('/auth/')?{id}:[{id,account_type:'Rental Account'}]};};
 try {assert.equal((await invoke({operationId:id,action:'create',rentals:[]})).code,403);assert.equal(mutations,0);}finally{global.fetch=original;}
});
test('recurring edit rejects privilege fields, incomplete times, ambiguous dates and invalid scope',()=>{
 const base={action:'request_update',rentalRequestId:id};
 for(const patch of [{payment_status:'paid'},{claimed_member_id:id},{event_start_time:'10:00'},{event_date:'Nov23 &25'}]) assert.throws(()=>handler.commandFromBody({...base,patch},false));
 assert.throws(()=>handler.commandFromBody({...base,scope:'other'},false));
 assert.throws(()=>handler.commandFromBody({action:'create',rentals:[{event_date:'2026-10-06',event_start_time:'12:00',event_end_time:'11:00'}]},true));
});
