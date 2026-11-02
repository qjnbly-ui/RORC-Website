const test=require('node:test');
const assert=require('node:assert/strict');
const {previousMonth,buildPreview}=require('../api/_monthly-billing');
const month=previousMonth();
async function fixture(run) {
  const savedFetch=global.fetch, savedKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY='test-service';
  const data={members:[{id:'member',account_id:'account',member_name:'APCA',email_address:'apca@example.test',is_billing_owner:true}],billing:[],rentals:[],heaters:[],attendance:[],changes:[],links:[],heaterGroupMembers:[]};
  let role='Account Manager',broken='',reads=0;
  const tableKeys={account_members:'members',billing_line_items:'billing',rental_requests:'rentals',heater_use_entries:'heaters',timesheet_entries:'attendance',rental_change_requests:'changes',rental_thermostat_links:'links',heater_use_group_members:'heaterGroupMembers'};
  global.fetch=async(url,options={})=>{
    const path=new URL(url); const json=x=>({ok:true,status:200,json:async()=>x});
    if(path.pathname==='/auth/v1/user')return json({id:'auth-user'});
    if(path.searchParams.has('auth_user_id'))return json([{id:'manager',account_type:role}]);
    reads++;
    const table=path.pathname.split('/').pop();
    if(table===broken)return{ok:false,status:503};
    const rows=data[tableKeys[table]];assert.ok(rows,table);
    if(options.method==='POST') {
      assert.equal(table,'rental_thermostat_links','matching must not write charges or payments');
      const body=JSON.parse(options.body);
      const index=rows.findIndex(l=>l.rental_request_id===body.rental_request_id&&l.heater_use_entry_id===body.heater_use_entry_id);
      if(index<0)rows.push(body);else rows[index]={...rows[index],...body};
      return json([body]);
    }
    assert.ok(!options.method || options.method==='GET','matching must not update charge amounts or owners');
    const offset=Number(path.searchParams.get('offset')||0),limit=Number(path.searchParams.get('limit')||500);
    return json(rows.slice(offset,offset+limit));
  };
  const handler=require('../api/monthly-billing');
  async function request(method='GET',body={},headers={authorization:'Bearer test-user'}){
    const response={statusCode:200,status(code){this.statusCode=code;return this;},setHeader(){},json(data){this.body=data;return this;}};
    await handler({method,query:{month},headers,body:{month,...body}},response);
    return response;
  }
  try{await run({data,request,setRole:value=>{role=value;},breakTable:value=>{broken=value;},reads:()=>reads});}
  finally{global.fetch=savedFetch;if(savedKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=savedKey;}
}
test('monthly data pages beyond 500 records without losing charges',()=>fixture(async({data,request})=>{
  data.billing=Array.from({length:501},(_,i)=>({id:`item-${i}`,account_member_id:'member',amount_cents:100,created_at:`${month}-15T12:00:00Z`}));
  const result=await request();assert.equal(result.statusCode,200);assert.equal(result.body.accounts[0].items.length,501);assert.equal(result.body.accounts[0].readyCents,50100);
}));
test('monthly endpoint refuses unauthenticated and non-manager access before reading billing records',()=>fixture(async({request,setRole,reads})=>{
  assert.equal((await request('GET',{},{})).statusCode,401);setRole('Special Access Account');assert.equal((await request()).statusCode,403);assert.equal(reads(),0);
}));
test('source fetch failures prevent presenting an incomplete monthly total',()=>fixture(async({request,breakTable})=>{
  breakTable('heater_use_entries');assert.equal((await request()).statusCode,502);
}));
test('changed charges require a fresh review before preparation or sending',()=>fixture(async({data,request})=>{
  data.billing=[{id:'item',account_member_id:'member',amount_cents:100,created_at:`${month}-15T12:00:00Z`}];
  const fingerprint=buildPreview(month,data).accounts[0].fingerprint;data.billing[0].amount_cents=200;
  const result=await request('POST',{action:'send',accountId:'account',fingerprint});assert.equal(result.statusCode,409);assert.match(result.body.error,/Charges changed/);
}));
test('unprepared rentals cannot be sent',()=>fixture(async({data,request})=>{
  data.rentals=[{id:'rental',claimed_member_id:'member',rental_status:'confirmed',event_date:`${month}-15`,estimated_total_cents:200}];
  const fingerprint=buildPreview(month,data).accounts[0].fingerprint;
  const result=await request('POST',{action:'send',accountId:'account',fingerprint});assert.equal(result.statusCode,409);assert.match(result.body.error,/Prepare the rental/);
}));
function heaterFixture(data) {
  data.rentals=[{id:'event',claimed_member_id:'member',rental_status:'confirmed',event_date:`${month}-15`,event_start_time:'12:00',event_end_time:'14:00',estimated_total_cents:0}];
  // Offset -07:00 keeps the saved facility wall time inside the event in summer; in winter 13:00 UTC-7 is 12:00 local.
  data.heaters=[{id:'heat',used_on:`${month}-15`,start_at:`${month}-15T13:00:00-07:00`,end_at:`${month}-15T13:15:00-07:00`,responsible_member_id:'member'}];
  data.billing=[{id:'heat-fee',account_member_id:'member',heater_use_entry_id:'heat',amount_cents:329,created_at:`${month}-15T20:00:00Z`}];
}
test('batch matching writes shared rental links without creating or moving billing charges',()=>fixture(async({data,request})=>{
  heaterFixture(data);const before=JSON.stringify(data.billing);
  const fingerprint=buildPreview(month,data).accounts[0].fingerprint;
  const result=await request('POST',{action:'match',accountId:'account',fingerprint});
  assert.equal(result.statusCode,200);assert.equal(result.body.matched,1);assert.equal(data.links[0].rental_request_id,'event');assert.equal(data.links[0].ignored_at,null);assert.equal(JSON.stringify(data.billing),before);
  assert.equal(result.body.accounts[0].heaterMatches[0].status,'attached');
}));
test('manual matching cannot attach a session to a foreign account or date',()=>fixture(async({data,request})=>{
  heaterFixture(data);const fingerprint=buildPreview(month,data).accounts[0].fingerprint;
  const result=await request('POST',{action:'attach',accountId:'account',heaterId:'heat',rentalId:'foreign-event',fingerprint});assert.equal(result.statusCode,409);assert.equal(data.links.length,0);
}));
test('reviewed separate usage stays separate and is safe to retry',()=>fixture(async({data,request})=>{
  heaterFixture(data);
  for(let n=0;n<2;n++){
    const fingerprint=buildPreview(month,data).accounts[0].fingerprint;
    const result=await request('POST',{action:'separate',accountId:'account',heaterId:'heat',fingerprint});assert.equal(result.statusCode,200);assert.equal(result.body.accounts[0].heaterMatches[0].status,'separate');
  }
  assert.equal(data.links.length,1);assert.equal(data.billing.length,1);
}));
test('unresolved heater matches block invoice delivery',()=>fixture(async({data,request})=>{
  heaterFixture(data);const fingerprint=buildPreview(month,data).accounts[0].fingerprint;
  const result=await request('POST',{action:'send',accountId:'account',fingerprint});assert.equal(result.statusCode,409);assert.match(result.body.error,/Match or review/);
}));
test('existing invoices prevent attachment changes',()=>fixture(async({data,request})=>{
  heaterFixture(data);Object.assign(data.billing[0],{stripe_invoice_id:'in_existing',stripe_invoice_status:'open'});
  const fingerprint=buildPreview(month,data).accounts[0].fingerprint;
  const result=await request('POST',{action:'attach',accountId:'account',heaterId:'heat',rentalId:'event',fingerprint});assert.equal(result.statusCode,409);assert.equal(data.links.length,0);
}));
test('manual review resolves duplicate links to one event without touching charges',()=>fixture(async({data,request})=>{
  heaterFixture(data);data.rentals.push({...data.rentals[0],id:'second'});
  data.links=data.rentals.map(r=>({rental_request_id:r.id,heater_use_entry_id:'heat',ignored_at:null}));
  const fingerprint=buildPreview(month,data).accounts[0].fingerprint;
  const result=await request('POST',{action:'attach',accountId:'account',heaterId:'heat',rentalId:'event',fingerprint});assert.equal(result.statusCode,200);
  assert.equal(data.links.filter(l=>!l.ignored_at).length,1);assert.equal(result.body.accounts[0].heaterMatches[0].rental.id,'event');assert.equal(data.billing.length,1);
}));
test('pending event changes prevent automatic attachment',()=>fixture(async({data,request})=>{
  heaterFixture(data);data.changes=[{id:'change',rental_request_id:'event',status:'pending'}];
  const account=buildPreview(month,data).accounts[0];assert.equal(account.heaterMatches[0].status,'review');
  const result=await request('POST',{action:'attach',accountId:'account',heaterId:'heat',rentalId:'event',fingerprint:account.fingerprint});assert.equal(result.statusCode,409);assert.equal(data.links.length,0);
}));
test('preparing monthly invoices also saves unique Rentals heater suggestions without a separate matching step',()=>fixture(async({data,request})=>{
  heaterFixture(data);const before=JSON.stringify(data.billing);
  const account=buildPreview(month,data).accounts[0];
  const result=await request('POST',{action:'prepare',accountId:'account',fingerprint:account.fingerprint});
  assert.equal(result.statusCode,200);assert.equal(result.body.matched,1);assert.equal(result.body.prepared,0);assert.equal(result.body.accounts[0].heaterMatches[0].status,'attached');assert.equal(JSON.stringify(data.billing),before);
}));
