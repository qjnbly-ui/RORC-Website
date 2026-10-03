const {test}=require('node:test');const assert=require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';const {getVerifiedRentalMember}=require('../api/rental-request');
const uid='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
test('anonymous rental remains anonymous; account selection requires authentication',async()=>{
 assert.equal(await getVerifiedRentalMember({headers:{}}),null);
 await assert.rejects(getVerifiedRentalMember({headers:{'x-rorc-account-member':target}}),{status:401});
});
test('signed rentals resolve their authorized account for ownership and existing pricing',async()=>{
 const prior=global.fetch;let grant=true;
 global.fetch=async(url)=>({ok:true,json:async()=>String(url).includes('/auth/')?{id:uid}:String(url).includes('member_account_access?')?(grant?[{account_member_id:target}]:[]):String(url).includes('auth_user_id=')?[]:[{id:target,account_id:target,account_type:'Special Access Account'}]});
 try {const req={headers:{authorization:'Bearer fixture','x-rorc-account-member':target}};const member=await getVerifiedRentalMember(req);assert.equal(member.id,target);assert.equal(member.account_type,'Special Access Account');grant=false;await assert.rejects(getVerifiedRentalMember(req),{status:403});}finally{global.fetch=prior;}
});
