const test=require('node:test');
const assert=require('node:assert/strict');
const {previousMonth,buildPreview}=require('../api/_monthly-billing');
const month=previousMonth();
async function fixture(run) {
  const savedFetch=global.fetch, savedKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY='test-service';
  const data={members:[{id:'member',account_id:'account',member_name:'APCA',email_address:'apca@example.test',is_billing_owner:true}],billing:[],rentals:[],heaters:[],attendance:[],changes:[]};
  let role='Account Manager',broken='',reads=0;
  const tableKeys={account_members:'members',billing_line_items:'billing',rental_requests:'rentals',heater_use_entries:'heaters',timesheet_entries:'attendance',rental_change_requests:'changes'};
  global.fetch=async(url)=>{
    const path=new URL(url); const json=x=>({ok:true,status:200,json:async()=>x});
    if(path.pathname==='/auth/v1/user')return json({id:'auth-user'});
    if(path.searchParams.has('auth_user_id'))return json([{id:'manager',account_type:role}]);
    reads++;
    const table=path.pathname.split('/').pop();
    if(table===broken)return{ok:false,status:503};
    const rows=data[tableKeys[table]];assert.ok(rows,table);
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
