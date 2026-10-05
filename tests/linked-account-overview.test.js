const {test}=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/linked-account-overview');
const {render}=require('../scripts/rorc-linked-accounts');
const ids=['9ef9ee35-93d8-458f-8383-59974e0d0706','a26535e3-1cc4-4509-86aa-70ee53118e1b','81688fcb-8091-42f9-9d3f-74206d99f621'];
function response(){return {setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};}
test('overview reads only RPC-authorized accounts using the user JWT and an independent scope per account',async()=>{
 const original=global.fetch;process.env.SUPABASE_SERVICE_ROLE_KEY='apikey-only';const requests=[];
 global.fetch=async(url,options)=>{
  requests.push({url,options});
  assert.equal(options.headers.Authorization,'Bearer user-token');
  assert.equal(options.headers.apikey,'apikey-only');
  if(url.endsWith('rpc/list_my_accounts'))return {ok:true,json:async()=>ids.map((id,i)=>({account_member_id:id,account_id:id,member_name:['Margaret','KBYD','APCA'][i]}))};
  assert.ok(ids.includes(options.headers['x-rorc-account-member']));
  return {ok:true,json:async()=>[]};
 };
 try {const res=response();await handler({method:'GET',headers:{authorization:'Bearer user-token','x-rorc-account-member':'untrusted'}},res);assert.equal(res.code,200);assert.equal(res.body.accounts.length,3);assert.equal(requests.length,19);assert.equal(requests.some(r=>r.url.includes('untrusted')),false);} finally{global.fetch=original;}
});
test('missing or expired login never falls back to service-role reads',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;return {ok:false,status:401};};
 try {let res=response();await handler({method:'GET',headers:{}},res);assert.equal(res.code,401);assert.equal(calls,0);res=response();await handler({method:'GET',headers:{authorization:'Bearer expired'}},res);assert.equal(res.code,401);assert.equal(calls,1);} finally{global.fetch=original;}
});
test('overview displays separate account info, hides canceled bookings, and escapes names and notes',()=>{
 const account={profile:{member_name:'KBYD <script>',account_number:'#16'},billing:[],bookings:[{event_name:'Canceled',event_date:'2099-01-01',rental_status:'canceled'},{event_name:'Future recess',event_date:'2099-01-02',event_start_time:'12:30',event_end_time:'13:00',rental_status:'confirmed',estimated_total_cents:200}],heater:[],attendance:[],door:[]};
 const html=render([account,{...account,profile:{member_name:'APCA',account_number:'#29'}}]);assert.match(html,/KBYD &lt;script&gt;/);assert.match(html,/APCA/);assert.match(html,/Future recess/);assert.doesNotMatch(html,/Canceled/);assert.match(html,/\$2\.00/);
});
