// Loopback-only UI fixture: exact app preferences renderer/save handler and manager API.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
const handler=require('../api/sms-preferences'),root=path.join(__dirname,'..');
let config={enabled:false};const manager='11111111-1111-4111-8111-111111111111';
global.fetch=async(url,options={})=>{url=String(url);let data=[];
 if(url.includes('/auth/v1/user'))data={id:manager};
 else if(url.includes('/account_members?'))data=[{id:manager,account_type:'Account Manager'}];
 else if(url.includes('/automation_settings?')){if(options.method==='POST')config=JSON.parse(options.body).config;data=[{config}];}
 else if(!url.includes('/rorc_receptionist_sms_consent?'))throw Error('Fixture refused external request');
 return {ok:true,json:async()=>data};
};
const app=fs.readFileSync(path.join(root,'RORC App/app.js'),'utf8');
const functions=app.slice(app.indexOf('function renderSmsPreferencesPanel()'),app.indexOf('function updateCommunicationsBadge()'));
const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><main style="width:100%;max-width:1100px;padding:20px;margin:auto"><h1>Calls &amp; Messages</h1><p>Local synthetic fixture. No real texts or bookings.</p><p id="communicationsPageStatus" role="status"></p><div id="panel"></div></main><script>
const communicationsState={activeTab:'preferences',bookingAi:null,bookingAiSaving:false,preferenceSummary:{total:0,optedIn:0,optedOut:0},preferenceFilter:'opt_out',preferenceSearch:''};
const escapeAttribute=v=>String(v).replaceAll('"','&quot;');
const communicationsAuthHeaders=()=>({Authorization:'Bearer fixture-manager'});
const renderSmsPreferencesList=()=>{document.querySelector('#smsPreferencesList').textContent='No fixture opt-outs.';};
async function loadSmsPreferences(){const result=await(await fetch('/api/sms-preferences',{headers:communicationsAuthHeaders()})).json();communicationsState.bookingAi=result.bookingAi;}
function renderCommunicationsPage(){document.querySelector('#panel').innerHTML=renderSmsPreferencesPanel();bindSmsPreferencesPanel();}
${functions}
renderCommunicationsPage();loadSmsPreferences().then(renderCommunicationsPage);
</script>`;
http.createServer(async(req,res)=>{try{
 if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(path.join(root,'RORC App/app.css')));}
 if(req.url==='/api/sms-preferences'){let body='';for await(const chunk of req)body+=chunk;req.body=body?JSON.parse(body):{};res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};return handler(req,res);}
 res.setHeader('Content-Type','text/html');res.end(html);
}catch(error){res.statusCode=500;res.end(error.message);}}).listen(8768,'127.0.0.1',()=>console.log('Synthetic settings fixture http://127.0.0.1:8768'));
