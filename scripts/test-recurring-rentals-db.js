// Isolated fixture-only PostgreSQL verification; never accepts a remote DB URL.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
const {commandFromBody} = require('../api/recurring-rentals');
const container = process.env.RORC_TEST_CONTAINER || 'rorc-recurring-test-01';
if (!/^rorc-recurring-test-[a-z0-9-]+$/.test(container)) throw new Error('Only a named isolated RORC test container is permitted.');
function run(args,input='') { return new Promise((resolve,reject)=> {const child=spawn('docker',args);let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err.trim()||out.trim())));child.stdin.end(input);}); }
const sql = (text) => run(['exec','-i',container,'psql','-U','postgres','-d','rorc_fixture','-At','-v','ON_ERROR_STOP=1'],text);
const q = (value) => `'${JSON.stringify(value).replace(/'/g,"''")}'::jsonb`;
const manager='11111111-1111-4111-8111-111111111111',renter='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
async function op(command,id=randomUUID(),actor=manager) { return JSON.parse((await sql(`set request.jwt.claims='{"role":"service_role"}'; set role service_role; select public.apply_recurring_rental_operation('${actor}','${id}',${q(command)});`)).split('\n').at(-1)); }
function create(dates,start='10:00',end='11:00',extra={}) {return commandFromBody({action:'create',rentals:dates.map(event_date=>({contact_name:'Fixture Only',contact_phone:'',contact_email:'renter@example.invalid',contact_address:'',event_type:'Other',event_name:'Synthetic recurring rental',event_date,event_start_time:start,event_end_time:end,rental_type:'hourly',claimed_member_id:renter,...extra}))},true);}
(async()=>{
  await run(['exec',container,'dropdb','-U','postgres','--if-exists','rorc_fixture']);
  await run(['exec',container,'createdb','-U','postgres','rorc_fixture']);
  const fixture=fs.readFileSync(path.join(__dirname,'../tests/fixtures/recurring/schema.sql'),'utf8').replace('create role service_role;','alter role service_role bypassrls;').replace('create role anon; create role authenticated;','');
  await sql(fixture);
  const migration=fs.readdirSync(path.join(__dirname,'../supabase/migrations')).find(v=>v.endsWith('_recurring_rental_operations.sql'));
  await sql(fs.readFileSync(path.join(__dirname,'../supabase/migrations',migration),'utf8'));
  const command=create(['2026-10-06','2026-10-08']); const key=randomUUID();
  const concurrent=await Promise.all([op(command,key),op(command,key)]);
  assert.deepEqual(concurrent[0],concurrent[1]); assert.equal(concurrent[0].rentalIds.length,2);
  assert.equal(await sql('select count(*) from rental_requests;'),'2');
  await assert.rejects(op(create(['2026-10-13']),key),/Operation key/);
  await assert.rejects(op(create(['2026-10-15','2026-10-06'])),/conflict/);
  assert.equal(await sql("select count(*) from rental_requests where event_date='2026-10-15';"),'0');
  const race=await Promise.allSettled([op(create(['2026-11-03'])),op(create(['2026-11-03']))]);
  assert.equal(race.filter(v=>v.status==='fulfilled').length,1); assert.equal(race.filter(v=>v.status==='rejected').length,1);
  // Adjacent access and standalone maintenance are authoritative.
  await op(create(['2026-12-02'],'10:00','11:00',{addon_early_setup:true}));
  await assert.rejects(op(create(['2026-12-01'],'19:00','20:00')),/conflict/);
  await sql(`set request.jwt.claims='{"role":"service_role"}'; insert into events(title,event_type,start_at,end_at,created_by) values('Synthetic maintenance','maintenance','2026-12-10T18:00:00Z','2026-12-10T19:00:00Z','fixture');`);
  await assert.rejects(op(create(['2026-12-10'])),/conflict/);
  // Touching endpoints are available; update only one occurrence.
  await op(create(['2026-10-06'],'11:00','12:00'));
  const [first,second]=concurrent[0].rentalIds;
  await op({action:'update',scope:'this',rentalRequestId:first,patch:{event_name:'Single edited title'}});
  assert.equal(await sql(`select event_name from rental_requests where id='${second}';`),'Synthetic recurring rental');
  await op({action:'update',scope:'all',rentalRequestId:first,patch:{event_name:'Whole series title',event_start_time:'08:00',event_end_time:'09:00'}});
  assert.equal(await sql(`select count(*) from rental_requests where recurring_series_id='${key}' and event_name='Whole series title';`),'2');
  await assert.rejects(op({action:'request_cancel',scope:'all',rentalRequestId:first,patch:{}},randomUUID(),other),/belong/);
  // Renter series requests do not mutate reservations until manager approval.
  const requested=await op({action:'request_update',scope:'all',rentalRequestId:first,patch:{event_name:'Approved series title'}},randomUUID(),renter);
  assert.equal(requested.pendingReview,true);
  assert.equal(await sql(`select event_name from rental_requests where id='${first}';`),'Whole series title');
  const reqId=(await sql(`select id from rental_change_requests where recurring_operation_id='${requested.operationId}' limit 1;`)).trim();
  await assert.rejects(op({action:'approve',scope:'this',changeRequestId:reqId},randomUUID(),renter),/Manager/);
  const approveKey=randomUUID(); const approval={action:'approve',scope:'this',changeRequestId:reqId};
  await op(approval,approveKey); await op(approval,approveKey);
  assert.equal(await sql(`select count(*) from rental_change_requests where recurring_operation_id='${requested.operationId}' and status='approved';`),'2');
  // Billed history survives cancellation; edits requiring rebilling fail atomically.
  await sql(`set request.jwt.claims='{"role":"service_role"}'; update rental_requests set billing_finalized_at=now(),payment_status='paid' where id='${second}'; insert into billing_line_items(rental_request_id,amount_cents,posted_to_stripe_at,stripe_invoice_id) values('${second}',1000,now(),'in_fixture_only');`);
  await assert.rejects(op({action:'update',scope:'all',rentalRequestId:first,patch:{event_start_time:'06:00',event_end_time:'07:00'}}),/billing review/);
  assert.equal(await sql(`select event_start_time from rental_requests where id='${first}';`),'08:00');
  await op({action:'cancel',scope:'following',rentalRequestId:second,patch:{}});
  assert.equal(await sql(`select rental_status from rental_requests where id='${first}';`),'confirmed');
  assert.equal(await sql(`select payment_status from rental_requests where id='${second}';`),'paid');
  assert.equal(await sql(`select count(*) from billing_line_items where rental_request_id='${second}' and stripe_invoice_id='in_fixture_only';`),'1');
  assert.equal(await sql(`select status from events where rental_request_id='${second}' limit 1;`),'cancelled');
  assert.equal(await sql("select has_function_privilege('authenticated','public.apply_recurring_rental_operation(uuid,uuid,jsonb)','execute');"),'f');
  assert.equal(await sql("select has_function_privilege('anon','public.apply_recurring_rental_operation(uuid,uuid,jsonb)','execute');"),'f');
  // Invoke the real authenticated HTTP handler with mocked identity and real fixture RPC.
  const handler = require('../api/recurring-rentals');
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('/auth/v1/user')) return {ok:true,json:async()=>({id: options.headers.Authorization.endsWith('renter') ? renter : manager})};
    if (String(url).includes('/account_members?')) { const member=String(url).includes(renter)?renter:manager; return {ok:true,json:async()=>[{id:member,account_type:member===manager?'Account Manager':'Rental Account'}]}; }
    if (String(url).includes('/rpc/apply_recurring_rental_operation')) {
      const body=JSON.parse(options.body);
      try { const result=await op(body.command,body.operation_id,body.actor_id);return {ok:true,json:async()=>result}; }
      catch(error) {return {ok:false,status:409,json:async()=>({code:'55000',message:error.message})};}
    }
    throw new Error('Fixture test refused external request: '+url);
  };
  const invokeHandler=async(body,role)=> {const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({method:'POST',headers:{authorization:'Bearer fixture-'+role},body},res);return res;};
  try {
    const body={action:'create',operationId:randomUUID(),rentals:[{event_date:'2027-02-02',event_start_time:'10:00',event_end_time:'11:00',rental_type:'hourly',claimed_member_id:renter,contact_email:'renter@example.invalid'}]};
    const created=await invokeHandler(body,'manager');assert.equal(created.code,200);assert.deepEqual((await invokeHandler(body,'manager')).body,created.body);
    const booked=created.body.rentalIds[0];
    const pending=await invokeHandler({action:'request_cancel',scope:'all',rentalRequestId:booked,operationId:randomUUID(),patch:{}},'renter');assert.equal(pending.code,200);assert.equal(pending.body.pendingReview,true);
    assert.equal(await sql(`select rental_status from rental_requests where id='${booked}';`),'confirmed');
    const change=(await sql(`select id from rental_change_requests where recurring_operation_id='${pending.body.operationId}';`)).trim();
    assert.equal((await invokeHandler({action:'approve',operationId:randomUUID(),changeRequestId:change},'renter')).code,403);
    assert.equal((await invokeHandler({action:'approve',operationId:randomUUID(),changeRequestId:change},'manager')).code,200);
    assert.equal(await sql(`select rental_status from rental_requests where id='${booked}';`),'canceled');
  } finally { global.fetch=originalFetch; }
  console.log('PASS: PostgreSQL atomic creation/rollback, duplicate retries, concurrent conflicts, maintenance/setup overlap, scope edits, ownership, manager approval, billed-edit rollback, cancellation history, service-only RPC, authenticated HTTP manager/renter/approval flow.');
})().catch(error=>{console.error(error);process.exitCode=1;});
