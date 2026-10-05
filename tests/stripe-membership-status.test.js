const test = require('node:test');
const assert = require('node:assert/strict');
const { syncAccountMembershipPlan } = require('../api/_stripe-membership-sync');
process.env.STRIPE_PRICE_FULL_FACILITY_MONTHLY = 'price_full';
async function sync(status, type = 'Active Membership', extra = {}, hasUnpaidBalance = false) {
 const writes=[];
 const result=await syncAccountMembershipPlan({accountId:'account',hasUnpaidBalance,subscription:{status,items:{data:[{price:{id:'price_full'}}]},...extra},supabaseRest:async()=>[{id:'member',account_type:type},{id:'admin',account_type:'Account Manager'},{id:'restricted',account_type:'RESTRICTED ACCOUNT'},{id:'work',account_type:'Work Exchange Membership Program'}],updateSupabaseRows:async(path,payload)=>writes.push({path,payload})});
 return {result,writes};
}
test('scheduled cancellation preserves paid membership until it takes effect',async()=>{
 const {result,writes}=await sync('active','Active Membership',{cancel_at_period_end:true});
 assert.equal(result.plan.accountType,'Active Membership');assert.equal(writes.length,1);
});
test('canceled membership with unpaid balance retains past-due restriction',async()=>{
 const {result,writes}=await sync('canceled','Active Membership',{},true);
 assert.equal(result.plan.accountType,'Account Past Due NO ACCESS ALLOWED');
 assert.deepEqual(writes[1],{path:'account_members?id=in.(member)',payload:{account_type:'Account Past Due NO ACCESS ALLOWED'}});
});
test('settled canceled membership can return from past due to open gym',async()=>{
 const {result}=await sync('canceled','Account Past Due NO ACCESS ALLOWED',{},false);
 assert.equal(result.plan.accountType,'Open Gym Only');
});
test('paused collection leaves an active membership active',async()=>{
 const {result}=await sync('active','Active Membership',{pause_collection:{behavior:'void'}});
 assert.equal(result.plan.accountType,'Active Membership');
});
test('completed cancellation becomes open gym without changing protected account types',async()=>{
 const {result,writes}=await sync('canceled');assert.equal(result.plan.accountType,'Open Gym Only');
 assert.deepEqual(writes[1],{path:'account_members?id=in.(member)',payload:{account_type:'Open Gym Only'}});
});
test('failed billing becomes past due and payment recovery restores the paid plan',async()=>{
 const overdue=await sync('past_due');assert.equal(overdue.result.plan.accountType,'Account Past Due NO ACCESS ALLOWED');
 const recovered=await sync('active','Account Past Due NO ACCESS ALLOWED');assert.equal(recovered.writes[1].payload.account_type,'Active Membership');
});
