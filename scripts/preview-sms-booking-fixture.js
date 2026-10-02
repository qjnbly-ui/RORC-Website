// Loopback fixture only: actual SMS preview/approval page and handler, synthetic PostgreSQL.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
const handler=require('../api/sms-booking-draft'),{hash}=require('../api/_sms-booking-store');
const root=path.join(__dirname,'..'),manager='11111111-1111-4111-8111-111111111111',phone='+15415550100',token='z'.repeat(43),draftId='55555555-5555-4555-8555-555555555555';
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
function sql(text){return new Promise((resolve,reject)=>{const p=spawn('docker',['exec','-i','rorc-recurring-test-01','psql','-U','postgres','-d','rorc_fixture','-At','-v','ON_ERROR_STOP=1']);let out='',err='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);p.on('close',code=>code?reject(new Error(err)):resolve(out.trim().split('\n').at(-1)));p.stdin.end(text);});}
const result=data=>({ok:true,json:async()=>data});
global.fetch=async(url,options={})=>{
 const parsed=new URL(url);
 if(parsed.pathname==='/auth/v1/user')return result({id:manager});
 if(parsed.pathname==='/rest/v1/account_members')return result([{id:manager,account_type:'Account Manager',phone_number:phone}]);
 if(parsed.pathname==='/rest/v1/rorc_receptionist_sms_consent')return result(JSON.parse(await sql(`select coalesce(json_agg(c),'[]') from rorc_receptionist_sms_consent c where phone_e164=${quote(phone)};`)));
 if(parsed.pathname==='/rest/v1/sms_booking_drafts'){
  if(options.method==='PATCH'){const body=JSON.parse(options.body);if(body.verified_member_id!==manager)throw Error('Invalid fixture member');return result(JSON.parse(await sql(`set request.jwt.claims='{"role":"service_role"}';with changed as(update sms_booking_drafts set verified_member_id='${manager}',resolved_command=${quote(JSON.stringify(body.resolved_command))}::jsonb where id='${draftId}' and verified_member_id is null and status='ready' returning *) select coalesce(json_agg(changed),'[]') from changed;`)));}
  const digest=parsed.searchParams.get('token_hash')?.replace(/^eq\./,'');return result(JSON.parse(await sql(`select coalesce(json_agg(d),'[]') from sms_booking_drafts d where token_hash=${quote(digest)};`)));
 }
 if(parsed.pathname==='/rest/v1/rpc/preview_rental_access'){const b=JSON.parse(options.body);try{return result(JSON.parse(await sql(`set role service_role;select preview_rental_access(${quote(JSON.stringify(b.proposals))}::jsonb,array[${b.excluded_ids.map(v=>quote(v)+'::uuid').join(',')}]::uuid[]);`)));}catch(error){return {ok:false,status:409,json:async()=>({code:'23P01',message:error.message})};}}
 if(parsed.pathname==='/rest/v1/rpc/confirm_sms_booking_draft'){
  const b=JSON.parse(options.body);if(b.actor_id!==manager)throw Error('Invalid fixture actor');
  try{return result(JSON.parse(await sql(`set request.jwt.claims='{"role":"service_role"}';set role service_role;select confirm_sms_booking_draft('${manager}',${quote(b.draft_token_hash)});`)));}catch(error){return {ok:false,status:409,json:async()=>({code:'55000',message:error.message})};}
 }
 throw Error('Fixture refused external request '+parsed.pathname);
};
(async()=>{
 const intent={action:'create',scope:'all',title:'SMS browser fixture',contactName:'SMS browser fixture',contactEmail:'fixture@example.invalid',startDate:'2027-06-01',endDate:'2027-06-10',startTime:'08:00',endTime:'09:00',weekdays:[2,4],exclusions:'2027-06-03',missing:[]};
 await sql(`insert into sms_booking_drafts(id,message_sid,phone_e164,message_body,status,token_hash,intent,expires_at) values('${draftId}','SM${'z'.repeat(32)}','${phone}','Synthetic browser fixture','ready','${hash(token)}',${quote(JSON.stringify(intent))}::jsonb,now()+interval '20 minutes') on conflict(id) do nothing;`);
 const html=fs.readFileSync(path.join(root,'sms-booking/index.html'),'utf8').replace('<script src="/scripts/rorc-supabase-client.js" defer></script>','<script>window.RORC_SUPABASE={getClient:async()=>({auth:{getSession:async()=>({data:{session:{access_token:"fixture-manager"}}})}})};</script>').replace('<script src="/scripts/rorc-auth-nav.js" defer></script>','');
 http.createServer(async(req,res)=>{try{
  if(req.url==='/api/sms-booking-draft'){let body='';for await(const p of req)body+=p;req.body=JSON.parse(body);res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};return handler(req,res);}
  if(req.url.startsWith('/sms-booking/')){res.setHeader('Content-Type','text/html');return res.end(html);}
  if(['/style.css','/scripts/rorc-sms-booking.js'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');return res.end(fs.readFileSync(path.join(root,req.url)));}
  res.statusCode=404;res.end('Fixture only');
 }catch(error){res.statusCode=500;res.end(error.message);}}).listen(8767,'127.0.0.1',()=>console.log(`SMS fixture http://127.0.0.1:8767/sms-booking/#draft=${token}`));
})().catch(error=>{console.error(error);process.exitCode=1;});
