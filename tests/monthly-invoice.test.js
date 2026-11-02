const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { buildPreview } = require('../api/_monthly-billing');

async function setup(run) {
  const originalFetch=global.fetch, originalLoad=Module._load;
  const savedEnv={SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_SERVICE_ROLE_KEY,STRIPE_SECRET_KEY:process.env.STRIPE_SECRET_KEY};
  const rows=[{id:'item-1',account_member_id:'member',amount_cents:1200,reason:'October event',created_at:'2026-10-14T12:00:00Z'}, {id:'item-2',account_member_id:'member',amount_cents:1647,reason:'October heat',created_at:'2026-10-30T12:00:00Z'}];
  const data={links:[],billing:rows,members:[{id:'member',account_id:'account',member_name:'APCA',email_address:'apca@example.test',is_billing_owner:true}],rentals:[],heaters:[],attendance:[],changes:[]};
  let invoice=null, failLine=false, failSend=false, creates=0, sends=0;
  const lines=[];
  const clone=x=>JSON.parse(JSON.stringify(x));
  const asyncList=values=>({async *[Symbol.asyncIterator](){yield* values;}});
  const stripe={
    customers:{retrieve:async()=>({id:"cus_account",email:data.members[0].email_address})},
    products:{search:async()=>({data:[{id:'prod_manual'}]})},
    prices:{list:async()=>({data:[{id:'price'}]})},
    invoiceItems:{create:async(payload,options)=>{
      assert.ok(options.idempotencyKey);
      if(failLine){failLine=false;throw new Error('Interrupted line creation');}
      lines.push({description:payload.description,metadata:payload.metadata,amount:rows.find(r=>r.id===payload.metadata.rorc_billing_line_item_id).amount_cents});return{id:'ii_1'};
    }},
    invoices:{
      list:()=>asyncList(invoice?[clone(invoice)]:[]),
      listLineItems:()=>asyncList(clone(lines)),
      create:async(payload,options)=>{assert.ok(options.idempotencyKey);assert.equal(payload.pending_invoice_items_behavior,'exclude');creates++;invoice={...payload,id:'in_month',status:'draft',total:0};return clone(invoice);},
      retrieve:async()=>{invoice.total=lines.reduce((n,l)=>n+l.amount,0);return clone(invoice);},
      finalizeInvoice:async()=>{invoice.status='open';return clone(invoice);},
      sendInvoice:async()=>{if(failSend){failSend=false;throw new Error('Email interrupted');}sends++;invoice.hosted_invoice_url='https://invoice.stripe.com/test';return clone(invoice);},
      update:async(id,patch)=>{invoice.metadata={...invoice.metadata,...patch.metadata};return clone(invoice);}
    }
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY='test-key';process.env.STRIPE_SECRET_KEY='test-stripe';
  Module._load=function(request,parent,isMain){if(request==='stripe')return()=>stripe;return originalLoad.call(this,request,parent,isMain);};
  const path=require.resolve('../api/create-stripe-invoice');delete require.cache[path];
  const {sendMonthlyInvoice}=require(path);Module._load=originalLoad;
  global.fetch=async(url,options={})=>{
    const p=String(url);
    const json=x=>({ok:true,status:200,json:async()=>x});
    if(p.includes('account_billing?select=account_id,stripe_customer_id'))return json([{account_id:'account',stripe_customer_id:'cus_account'}]);
    if(p.includes('account_members?select=id,account_id,member_name'))return json([{...data.members[0],accounts:{account_number:'29'}}]);
    if(p.includes('rental_requests?select=*'))return json(data.rentals);
    if(p.includes('heater_use_entries?select=id'))return json(data.heaters);
    if(p.includes('billing_line_items?select=id,heater_use_entry_id'))return json(rows);
    if(options.method==='PATCH'&&p.includes('heater_use_entries?id=in.'))return{ok:true,status:204};
    if(options.method==='PATCH'&&p.includes('billing_line_items?id=in.')){rows.forEach(row=>Object.assign(row,JSON.parse(options.body)));return{ok:true,status:204};}
    throw new Error(`Unexpected request ${p}`);
  };
  const send=()=>sendMonthlyInvoice({month:'2026-10',group:buildPreview('2026-10',data).accounts[0],data,managerId:'manager'});
  try {await run({send,data,rows,lines,interruptLine:()=>{failLine=true;},interruptSend:()=>{failSend=true;},stats:()=>({creates,sends,invoice})});}
  finally {global.fetch=originalFetch;Module._load=originalLoad;delete require.cache[path];for(const [key,value]of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
test('month-end invoice combines all charges, persists linkage, and repeated send does not duplicate invoice or email',()=>setup(async({send,rows,lines,stats})=>{
  const result=await send();assert.equal(result.id,'in_month');assert.equal(lines.length,2);assert.equal(stats().invoice.total,2847);assert.ok(rows.every(r=>r.stripe_invoice_id==='in_month'));
  await send();assert.equal(stats().creates,1);assert.equal(stats().sends,1);assert.equal(lines.length,2);
}));
test('interrupted line creation resumes the stored draft without creating a second invoice',()=>setup(async({send,rows,lines,stats,interruptLine})=>{
  interruptLine();await assert.rejects(send,/Interrupted line/);assert.ok(rows.every(r=>r.stripe_invoice_status==='draft'));
  await send();assert.equal(stats().creates,1);assert.equal(lines.length,2);assert.equal(stats().sends,1);
}));
test('email failure after finalization resumes sending the existing invoice',()=>setup(async({send,stats,interruptSend})=>{
  interruptSend();await assert.rejects(send,/Email interrupted/);assert.equal(stats().invoice.status,'open');
  await send();assert.equal(stats().creates,1);assert.equal(stats().sends,1);
}));
test('new charges after a monthly invoice was sent cannot create a second invoice',()=>setup(async({send,rows,stats})=>{
  await send();rows.push({id:'late',account_member_id:'member',amount_cents:100,created_at:'2026-10-30T12:00:00Z'});
  await assert.rejects(send,/additional charges need review/);assert.equal(stats().creates,1);
}));
test('charges already on an unrelated invoice are blocked',()=>setup(async({send,rows,stats})=>{
  rows[0].stripe_invoice_id='in_other';rows[0].stripe_invoice_status='open';
  await assert.rejects(send,/another invoice/);assert.equal(stats().creates,0);
}));
test('heater usage stays a separate dated invoice line even when an event attachment exists',()=>setup(async({send,data,rows,lines,stats})=>{
  data.rentals.push({id:'event',claimed_member_id:'member',event_name:'Lunch recess',event_date:'2026-10-30',rental_status:'confirmed'});
  data.heaters.push({id:'heat',used_on:'2026-10-30',system_type:'heat',start_at:'2026-10-30T19:30:00Z',end_at:'2026-10-30T19:45:00Z'});
  data.links.push({rental_request_id:'event',heater_use_entry_id:'heat',ignored_at:null});
  rows[1].heater_use_entry_id='heat';
  await send();
  const line=lines.find(l=>l.metadata.rorc_billing_line_item_id==='item-2');
  assert.equal(line.metadata.rorc_rental_request_id,undefined);assert.match(line.description,/Oct 30/);assert.ok(!line.description.includes('Lunch recess'));assert.equal(lines.length,2);assert.equal(stats().invoice.total,2847);
}));
