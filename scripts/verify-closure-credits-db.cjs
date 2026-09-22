// Optional verification tool: provide @electric-sql/pglite through NODE_PATH.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const managerId='11111111-1111-4111-8111-111111111111';
async function fixture() {
 const db = new PGlite();
 await db.exec(`
 create role anon; create role authenticated; create role service_role bypassrls;
 create table accounts(id uuid primary key,account_number text);
 create table account_members(id uuid primary key,account_id uuid references accounts(id),member_name text,is_billing_owner boolean,account_type text,auth_user_id uuid);
 create table account_billing(account_id uuid primary key references accounts(id),stripe_customer_id text,stripe_subscription_id text);
 insert into accounts values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','1001'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','1002'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','1003');
 insert into account_members values ('${managerId}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Sample Family',true,'Account Manager','11111111-1111-4111-8111-111111111112'),('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Sample Weight Room',true,'Weight Room Only',null),('33333333-3333-4333-8333-333333333333','cccccccc-cccc-4ccc-8ccc-cccccccccccc','Sample Open Gym',true,'Open Gym Only',null);
 insert into account_billing values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cus_full','sub_full'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cus_weight','sub_weight'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','cus_open','sub_open');
 grant select on accounts,account_members,account_billing to service_role;
 `);
 await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',fs.readdirSync(path.join(root,'supabase/migrations')).find(name=>name.endsWith('_facility_closure_credits.sql'))),'utf8'));
 const rpc = async (action,id,data={}) => (await db.query('select manage_facility_closure_credit($1,$2,$3::jsonb) as result',[action,id,JSON.stringify(data)])).rows[0].result;
 return {db,rpc,managerId};
}


const assert=require('node:assert/strict');
(async()=>{
 const {db,rpc,managerId}=await fixture();
 const c=await rpc('create',null,{starts_on:'2026-09-08',reopens_on:'2026-09-21',reason:'Maintenance',manager_id:managerId});
 await assert.rejects(rpc('create',null,{starts_on:'2026-09-10',reopens_on:'2026-09-20',reason:'Overlap',manager_id:managerId}),/overlap/);
 const rows=(await db.query('select * from facility_closure_credit_accounts order by id')).rows;
 assert.equal(rows.length,3);
 for (const row of rows) await rpc('preview',c.id,{row_id:row.id,preview:{amount:row.customer_id==='cus_open'?0:800,details:[],warnings:[],fingerprint:'fingerprint'}});
 const snapshot=()=>db.query("select coalesce(jsonb_agg(jsonb_build_object('id',id,'state',state,'fingerprint',fingerprint,'amount_cents',amount_cents) order by id),'[]') as rows from facility_closure_credit_accounts");
 await assert.rejects(rpc('begin',c.id,{manager_id:managerId,expected_rows:[]}),/preview changed/);
 await rpc('begin',c.id,{manager_id:managerId,expected_rows:(await snapshot()).rows[0].rows});
 await assert.rejects(rpc('cancel',c.id),/unused draft/);
 const paid=rows.filter(r=>r.customer_id!=='cus_open');
 await rpc('claim',c.id,{row_id:paid[0].id});
 await assert.rejects(rpc('claim',c.id,{row_id:paid[0].id}),/processing/);
 await assert.rejects(rpc('exclude',c.id,{row_id:paid[0].id,note:'Race'}),/cannot be excluded/);
 await rpc('finish',c.id,{row_id:paid[0].id,transaction_id:'cbtxn_one'});
 assert.equal((await rpc('claim',c.id,{row_id:paid[0].id})).state,'applied');
 await rpc('claim',c.id,{row_id:paid[1].id});
 await db.query("update facility_closure_credit_accounts set claimed_at=now()-interval '3 minutes' where id=$1",[paid[1].id]);
 await rpc('claim',c.id,{row_id:paid[1].id});
 await rpc('finish',c.id,{row_id:paid[1].id,transaction_id:'cbtxn_two'});
 assert.equal((await db.query('select status from facility_closure_credits')).rows[0].status,'applied');
 await db.exec("delete from account_billing where stripe_customer_id='cus_weight'");
 const missing=await rpc('create',null,{starts_on:'2026-08-01',reopens_on:'2026-08-05',reason:'Missing customer test',manager_id:managerId});
 assert.equal((await db.query('select customer_id from facility_closure_credit_accounts where closure_id=$1 and account_id=$2',[missing.id,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])).rows[0].customer_id,null);
 await db.exec('set role authenticated');
 await assert.rejects(db.query('select * from facility_closure_credit_accounts'),/permission denied/);
 await assert.rejects(rpc('create',null,{}),/permission denied/);
 await db.exec('reset role; set role anon');
 await assert.rejects(db.query('select * from facility_closure_credits'),/permission denied/);
 await db.exec('reset role');
 await db.close();
 console.log('PASS: migration, overlap prevention, approval snapshot, serialized claims, retry recovery, completion and anonymous/member access restrictions.');
})().catch(e=>{console.error(e);process.exitCode=1});
