// Actual conversation renderer and manager API, synthetic storage, loopback only.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
const handler=require('../api/communications'),root=path.join(__dirname,'..');
const id='11111111-1111-4111-8111-111111111111';
let config={id,phone_e164:'+15415550100',ai_mode:'automatic',ai_resume_after_minutes:20,ai_paused_until:new Date(Date.now()+20*60000).toISOString()};
global.fetch=async(url,options={})=>{url=String(url);let rows;
 if(url.includes('/auth/v1/user'))rows={id};
 else if(url.includes('/account_members?'))rows=[{id,account_type:'Account Manager',member_name:'Fixture Member',phone_number:'+15415550100'}];
 else if(url.includes('/staff_communication_threads?'))rows=[config];
 else if(url.endsWith('/rpc/set_sms_conversation_ai')){const body=JSON.parse(options.body);if(body.thread_id!==id)throw Error('Unknown fixture thread');config={...config,ai_mode:body.mode,ai_resume_after_minutes:body.resume_minutes,...(body.resume_now||body.mode==='never'?{ai_paused_until:null}:{})};rows=config;}
 else throw Error('Fixture refused external request');
 return {ok:true,json:async()=>rows};
};
const app=fs.readFileSync(path.join(root,'RORC App/app.js'),'utf8');
const functions=app.slice(app.indexOf('function renderConversationAiControls('),app.indexOf('async function selectCommunicationThread('));
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><main style="width:100%;max-width:1100px;margin:auto;padding:20px"><h1>Calls &amp; Messages</h1><p>Local synthetic conversation. No real texts or bookings.</p><div id="communicationsConversation"></div><button id="fixtureReload">Reload settings</button><button id="fixturePause">Simulate staff reply</button><button id="fixtureFail">Simulate next save failure</button></main><script>
const communicationsState={selectedThreadId:'${id}',threads:[],messages:[],draftBody:'',draftPhone:''};
const escapeHtml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');const escapeAttribute=escapeHtml;
const selectedCommunicationThread=()=>communicationsState.threads[0];const communicationThreadName=()=> 'Fixture Member';const formatCommunicationsPhone=()=> '(541) 555-0100';const formatShortTime=v=>new Date(v).toLocaleString();
const communicationContactForPhone=()=>null;const communicationStatusLabel=()=>'';const sendCommunicationMessage=e=>{e.preventDefault();};const renderCommunicationsPage=()=>{};
async function communicationsRequest(path='',options={}){const response=await fetch('/api/communications'+path,{...options,headers:{Authorization:'Bearer fixture-manager','Content-Type':'application/json'}});const result=await response.json();if(!response.ok)throw Error(result.error);return result;}
${functions}
async function reload(){communicationsState.threads=(await communicationsRequest()).threads;renderCommunicationConversation();}
document.getElementById('fixtureReload').onclick=reload;
document.getElementById('fixturePause').onclick=async()=>{await fetch('/fixture-pause',{method:'POST'});await reload();};
document.getElementById('fixtureFail').onclick=()=>fetch('/fixture-fail',{method:'POST'});
reload();
</script>`;
let failNext=false;
http.createServer(async(req,res)=>{try{
 if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(path.join(root,'RORC App/app.css')));}
 if(req.url==='/fixture-pause'&&req.method==='POST'){config.ai_paused_until=new Date(Date.now()+config.ai_resume_after_minutes*60000).toISOString();return res.end('ok');}
 if(req.url==='/fixture-fail'&&req.method==='POST'){failNext=true;return res.end('ok');}
 if(req.url==='/api/communications'){
  if(!['GET','PATCH'].includes(req.method)){res.statusCode=405;return res.end();}
  if(failNext&&req.method==='PATCH'){failNext=false;res.statusCode=503;res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({error:'Fixture save unavailable.'}));}
  let body='';for await(const chunk of req)body+=chunk;req.body=body?JSON.parse(body):{};req.query={};res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};return handler(req,res);
 }
 res.setHeader('Content-Type','text/html');res.end(html);
}catch(error){res.statusCode=500;res.end(error.message);}}).listen(8769,'127.0.0.1',()=>console.log('Synthetic conversation controls http://127.0.0.1:8769'));
