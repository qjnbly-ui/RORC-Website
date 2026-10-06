const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function api(fetcher){const context={require,URL,Buffer,process:{env:{SUPABASE_SERVICE_ROLE_KEY:'server-only'}},fetch:fetcher,module:{exports:{}}};vm.runInNewContext(fs.readFileSync(require.resolve('../api/sponsor-catalog'),'utf8'),context);return context.module.exports;}
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v},status(s){this.code=s;return this},json(b){this.body=b;return this}}}
const ok=data=>({ok:true,status:200,json:async()=>data});
test('public sponsor catalog projects only public fields',async()=>{
 const requests=[];const handler=api(async url=>{requests.push(url);return ok([{id:'1',name:'Sponsor',status:'active',artwork_url:'/image.jpg',owner:'Private',email:'private@test',source_data:{Paid:'Yes'}}])});
 const r=response();await handler({method:'GET',query:{public:'1'},headers:{}},r);
 assert.equal(r.code,200);assert.deepEqual(Object.keys(r.body.banners[0]).sort(),['artwork_url','id','name','status']);assert.match(requests[0],/select=id,name,status,artwork_url/);
});
test('private sponsor access rejects missing sessions and ordinary members',async()=>{
 const calls=[];const handler=api(async url=>{calls.push(url);return url.includes('/auth/')?ok({id:'user'}):ok([])});
 let r=response();await handler({method:'GET',headers:{},query:{}},r);assert.equal(r.code,401);assert.equal(calls.length,0);
 r=response();await handler({method:'GET',headers:{authorization:'Bearer member'},query:{}},r);assert.equal(r.code,403);assert.equal(calls.filter(x=>x.includes('sponsor_banners')).length,0);
});
test('payments address one banner and year and reject invalid dates and amounts',()=>{
 const h=api(()=>{});assert.equal(h.annual({id:'id',year:2027,payment_status:'unpaid'}).paid_date,null);
 assert.throws(()=>h.annual({year:2027,payment_status:'paid',paid_date:'2027-02-30'}));
 assert.throws(()=>h.annual({year:2027,payment_status:'paid',amount_cents:-1}));
 assert.throws(()=>h.profile({name:'Sponsor',artwork_url:'javascript:alert(1)'}));
});
test('annual UI keeps historical years and escapes imported details',()=>{
 const {render}=require('../scripts/rorc-sponsors');
 const html=render({banners:[{id:'a',name:'<script>',status:'active',source_data:{row:{Paid:'Yes'}}}],years:[{banner_id:'a',year:2025,payment_status:'paid',amount_cents:10000}]},{year:2026,status:'all',payment:'all',search:''});
 assert.match(html,/2026 · Unknown/);assert.match(html,/2025 · Paid/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/Original Drive record/);
});
test('completed orders reconcile the actual Stripe payment year without replacing history',async()=>{
 const {linkCompletedSponsor}=require('../api/_sponsor-catalog');const writes=[];
 const row={id:'s',status:'complete',business_name:'Sponsor',created_at:'2026-12-01',stripe_invoice_id:'in_1'};
 const rest=async path=>path.startsWith('sponsor_banners')?[{id:'a'}]:[];
 await linkCompletedSponsor(row,rest,async(p,m,b)=>{writes.push(b);return [b]}, {id:'in_1',status:'paid',amount_paid:12500,status_transitions:{paid_at:Date.parse('2027-01-02')/1000}});
 assert.equal(writes[0].year,2027);assert.equal(writes[0].paid_date,'2027-01-02');assert.equal(writes[0].amount_cents,12500);
 writes.length=0;await linkCompletedSponsor(row,async()=>[{id:'a',year:2027}],async()=>writes.push({}),{id:'in_1',status:'paid',status_transitions:{paid_at:Date.parse('2027-01-02')/1000}});assert.equal(writes.length,0);
});

