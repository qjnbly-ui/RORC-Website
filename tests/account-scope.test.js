const {test} = require('node:test');
const assert = require('node:assert/strict');
const {accountMemberFilter} = require('../api/_account-scope');
const user='11111111-1111-4111-8111-111111111111';
const selected='22222222-2222-4222-8222-222222222222';
const request={headers:{'x-rorc-account-member':selected}};
test('existing single-account requests retain login scope without an extra lookup',async()=>{
 assert.equal(await accountMemberFilter(user,{},()=>{throw Error('unexpected lookup');}),`auth_user_id=eq.${user}`);
});
test('explicit linked account resolves to its member; existing login is preserved',async()=>{
 const paths=[];const values=[[],[{account_member_id:selected}],[{id:selected,account_type:'Special Access Account'}]];
 assert.equal(await accountMemberFilter(user,request,async path=>{paths.push(path);return values.shift();}),`id=eq.${selected}`);
 assert.match(paths[1],new RegExp(`auth_user_id=eq.${user}`));
});
test('own profile may be selected without a delegation',async()=>{
 assert.equal(await accountMemberFilter(user,request,async()=>[{id:selected}]),`id=eq.${selected}`);
});
test('ungranted, revoked, invalid and manager delegations are denied',async()=>{
 for(const values of [[[],[]],[[],[{account_member_id:selected}],[]],[[],[{account_member_id:selected}],[{account_type:'Account Manager'}]]]){
  await assert.rejects(accountMemberFilter(user,request,async()=>values.shift()),{status:403});
 }
 await assert.rejects(accountMemberFilter(user,{headers:{'x-rorc-account-member':'bad'}},async()=>{throw Error('unexpected lookup');}),{status:403});
});
test('recurring changes use the authorized selected member and fail closed after revocation',async()=>{
 process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
 const handler=require('../api/recurring-rentals');const previous=global.fetch;let grant=true;const calls=[];
 global.fetch=async(url,options)=>{
  const text=String(url);let body=[];
  if(text.includes('/auth/'))body={id:user};
  else if(text.includes('member_account_access?'))body=grant?[{account_member_id:selected}]:[];
  else if(text.includes('account_members?')&&!text.includes('auth_user_id='))body=[{id:selected,account_type:'Special Access Account'}];
  else if(text.includes('/rpc/')){calls.push(JSON.parse(options.body));body={success:true,pendingReview:true};}
  return {ok:true,json:async()=>body};
 };
 const invoke=async()=>{const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({method:'POST',headers:{...request.headers,authorization:'Bearer fixture-only'},body:{operationId:user,action:'request_cancel',rentalRequestId:selected}},res);return res;};
 try{assert.equal((await invoke()).code,200);assert.equal(calls[0].actor_id,selected);grant=false;assert.equal((await invoke()).code,403);assert.equal(calls.length,1);}finally{global.fetch=previous;}
});
