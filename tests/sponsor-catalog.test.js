const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function api(fetcher){const context={require,URL,Buffer,process:{env:{SUPABASE_SERVICE_ROLE_KEY:'server-only'}},fetch:fetcher,module:{exports:{}}};vm.runInNewContext(fs.readFileSync(require.resolve('../api/sponsor-catalog'),'utf8'),context);return context.module.exports;}
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v},status(s){this.code=s;return this},json(b){this.body=b;return this}}}
const ok=data=>({ok:true,status:200,json:async()=>data});
test('public sponsor catalog projects only public fields',async()=>{
 const requests=[];const handler=api(async url=>{requests.push(url);return ok([{id:'1',name:'Sponsor',status:'active',artwork_url:'/image.jpg',owner:'Private',email:'private@test',source_data:{Paid:'Yes'}}])});
 const r=response();await handler({method:'GET',query:{public:'1'},headers:{}},r);
 assert.equal(r.code,200);assert.deepEqual(Object.keys(r.body.banners[0]).sort(),['artwork_url','email','id','name','owner','phone','status']);assert.match(requests[0],/select=id,name,status,artwork_url/);assert.equal(r.body.banners[0].email,'');assert.equal(r.body.banners[0].phone,'');
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

test('large 9000 by 5400 artwork is resized with its proportions preserved before upload',async()=>{
 const {prepareImage}=require('../scripts/rorc-sponsors');let closed=false,drawn;
 const image={width:9000,height:5400,close(){closed=true}};
 const canvas={getContext(){return {drawImage(...args){drawn=args}}},toBlob(done,type){done({size:900000,type})}};
 const result=await prepareImage({size:12000000,type:'image/png'},{decode:async()=>image,createCanvas:()=>canvas,toBase64:async blob=>{assert.ok(blob.size<2000000);return 'encoded'}});
 assert.equal(canvas.width,3200);assert.equal(canvas.height,1920);assert.equal(drawn[3],3200);assert.equal(result.content_type,'image/webp');assert.equal(result.base64,'encoded');assert.equal(closed,true);
});
test('small artwork stays unchanged and decode failures remain visible errors',async()=>{
 const {prepareImage}=require('../scripts/rorc-sponsors');const file={size:90000,type:'image/png'};
 await prepareImage(file,{decode:async()=>({width:300,height:180}),toBase64:async blob=>{assert.equal(blob,file);return 'unchanged'}});
 await assert.rejects(prepareImage({size:10,type:'image/tiff'}),/Choose a JPG/);
 await assert.rejects(prepareImage(file,{decode:async()=>{throw new Error('Unreadable image')}}),/Unreadable image/);
});
test('selecting an owner counts and shows their banners across statuses',()=>{
 const {render}=require('../scripts/rorc-sponsors');
 const banners=[{id:'a',name:'First banner',owner:'Margaret Millen',status:'active'},{id:'b',name:'Archived banner',owner:' margaret millen ',status:'taken_down'},{id:'c',name:'Other banner',owner:'Other Owner',status:'active'}];
 const html=render({banners,years:[]},{year:2026,status:'all',payment:'all',search:'',owner:'owner:margaret millen'});
 assert.match(html,/Margaret Millen \(2\)/);assert.match(html,/2 banners total · 2 shown/);assert.match(html,/<h4>First banner<\/h4>/);assert.match(html,/<h4>Archived banner<\/h4>/);assert.doesNotMatch(html,/<h4>Other banner<\/h4>/);assert.match(html,/list="sponsorOwnerNames"/);
});
test('public contact details require an explicit manager opt-in',async()=>{
 const handler=api(async()=>ok([{id:'a',name:'Banner',owner:'Owner',status:'active',artwork_url:'/image.jpg',phone:'5551234567',email:'public@example.test',public_contact:true,notes:'private',source_data:{}}]));
 const r=response();await handler({method:'GET',query:{public:'1'},headers:{}},r);
 assert.equal(r.body.banners[0].owner,'Owner');assert.equal(r.body.banners[0].phone,'5551234567');assert.equal(r.body.banners[0].email,'public@example.test');assert.equal(r.body.banners[0].notes,undefined);assert.equal(r.body.banners[0].source_data,undefined);
 assert.equal(handler.profile({name:'Banner',public_contact:'false'}).public_contact,false);
});

test('owner autofill matches full names and refuses conflicting contacts',()=>{
 const {ownerContact}=require('../scripts/rorc-sponsors');
 const records=[{owner:'Jane Smith',phone:'541-555-1234',email:'Jane@example.test'},{owner:' jane smith ',phone:'(541) 555-1234',email:'jane@example.test'},{owner:'Other person',email:'other@example.test'}];
 assert.deepEqual(ownerContact(records,' JANE SMITH '),{matched:true,conflicts:[],phone:'541-555-1234',email:'Jane@example.test'});
 assert.equal(ownerContact(records,'Jane').matched,false);
 assert.equal(ownerContact(records,'').matched,false);
 const conflicting=ownerContact([...records,{owner:'Jane Smith',email:'different@example.test'}],'Jane Smith');
 assert.deepEqual(conflicting.conflicts,['email']);assert.equal(conflicting.email,undefined);assert.equal(conflicting.phone,'541-555-1234');
});
