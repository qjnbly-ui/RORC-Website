// Local-only fixture. No credentials, payments, bookings or notifications.
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const profiles=ids.map((id,i)=>({account_member_id:id,account_id:id,account_number:['#106','#29','#16'][i],member_name:['Fixture Personal','Fixture APCA','Fixture KBYD'][i],account_type:'Active Membership',email_address:'fixture@example.invalid',phone_number:'555',is_billing_owner:false,billing_status:'None'}));
const bootstrap=`window.supabase={createClient:(url,key,options)=>{const request=async(path,body)=>{const response=await options.global.fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {data:await response.json(),error:null};};return {auth:{getSession:async()=>({data:{session:{access_token:'fixture-only',user:{id:'fixture-user',email:'personal@example.invalid'}}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe:()=>{}}}}),updateUser:async()=>{throw Error('Organization edits must not change login');}},rpc:(name,body)=>request('/fixture/'+name,body),from:(table)=>{const query={select:()=>query,order:()=>query,eq:()=>query,is:()=>query,limit:()=>query,in:()=>query,neq:()=>query,maybeSingle:()=>request('/fixture/'+table),then:(resolve,reject)=>request('/fixture/'+table).then(resolve,reject)};return query;},realtime:{isConnected:()=>true,setAuth:async()=>{}},channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:async()=>{}};}};`;
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.endsWith('/vendor/supabase.min.js')){res.setHeader('Content-Type','text/javascript');return res.end('/* synthetic SDK installed in fixture head */');}const member=req.headers['x-rorc-account-member']||ids[0];
 res.setHeader('Cache-Control','no-store');
 if(url.pathname.startsWith('/fixture/')||url.pathname.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  if(url.pathname==='/fixture/list_my_accounts')return res.end(JSON.stringify(profiles.map((p,i)=>({...p,is_primary:i===0}))));
  if(url.pathname==='/fixture/account_member_profiles')return res.end(JSON.stringify(profiles.filter(p=>p.account_member_id===member)));
  if(url.pathname==='/fixture/account_billing')return res.end(JSON.stringify({stripe_customer_id:member,billing_status:'None'}));
  if(url.pathname.startsWith('/fixture/'))return res.end('[]');
  return res.end(JSON.stringify({success:true,rentals:[],entries:[],notifications:[],events:[],member:{id:member},changeRequests:[]}));
 }
 let file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 if(url.pathname.endsWith('/'))file=path.join(file,'index.html');
 try{let data=fs.readFileSync(file);if(file.endsWith('.html'))data=Buffer.from(data.toString().replace('<head>','<head><script>'+bootstrap+'</script>'));res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(data);}catch(_){res.writeHead(404);res.end();}
}).listen(8771,'127.0.0.1',()=>console.log('Synthetic account-switcher fixture: http://127.0.0.1:8771/member-dashboard/'));
