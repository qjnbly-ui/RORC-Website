// Local-only preview of the actual calendar save/cancel functions. Synthetic DB only.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.join(__dirname,'..');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
const handler=require('../api/recurring-rentals');
const manager='11111111-1111-4111-8111-111111111111';
function sql(text){return new Promise((resolve,reject)=>{const p=spawn('docker',['exec','-i','rorc-recurring-test-01','psql','-U','postgres','-d','rorc_fixture','-At','-v','ON_ERROR_STOP=1']);let out='',err='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);p.on('close',code=>code?reject(new Error(err)):resolve(out.trim()));p.stdin.end(text);});}
global.fetch=async(url,options)=>{
 if(String(url).includes('/auth/v1/user'))return {ok:true,json:async()=>({id:manager})};
 if(String(url).includes('/account_members?'))return {ok:true,json:async()=>[{id:manager,account_type:'Account Manager'}]};
 if(String(url).includes('/rpc/apply_recurring_rental_operation')){const b=JSON.parse(options.body);try{const output=await sql(`set request.jwt.claims='{"role":"service_role"}'; set role service_role; select public.apply_recurring_rental_operation('${b.actor_id}','${b.operation_id}','${JSON.stringify(b.command).replace(/'/g,"''")}'::jsonb);`);return {ok:true,json:async()=>JSON.parse(output.split('\n').at(-1))};}catch(error){return {ok:false,status:409,json:async()=>({code:'55000',message:error.message})};}}
 throw new Error('Fixture preview refused external network request');
};
const app=fs.readFileSync(path.join(root,'RORC App/app.js'),'utf8');
function slice(a,b){return app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));}
const recurringMarkup=slice('<label id="calSeriesEditScopeField"','\n        <details id="calRentalDetails"').replace(/ hidden/g,'');
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body style="padding:16px;max-width:480px"><h2>Synthetic recurring booking check</h2><p>Local fixture only. No real bookings, messages or payments.</p><div id="calEventModal"><label class="cal-field-label">Title<input class="rorc-input" id="calEvTitle" value="Browser fixture series"></label><select id="calEvType"><option value="rental">Rental</option></select><label class="cal-field-label">Start date<input class="rorc-input" id="calEvDate" type="date" value="2027-04-06"></label><label class="cal-field-label">Start time<input class="rorc-input" id="calEvStart" type="time" value="10:00"></label><label class="cal-field-label">End time<input class="rorc-input" id="calEvEnd" type="time" value="11:00"></label><input id="calEvAllDay" type="checkbox"><input id="calEvPublic" type="checkbox"><input id="calEvDetailOnly" type="checkbox"><textarea id="calEvDesc" hidden></textarea>${recurringMarkup}<p id="calModalError" role="alert" hidden></p><button id="calModalSave" class="app-admin-btn">Save booking</button><button id="cancelSeries" class="app-admin-btn">Cancel selected scope</button></div><p id="result" role="status"></p><button id="edit" class="app-admin-btn">Edit first occurrence</button><script>
let currentAuthSession={access_token:'fixture-manager'},appUserSession={},calendarEvents=[];
const isAccountManager=()=>true,canRequestCalendarEventChanges=()=>false,normalizeEventTypeForUi=v=>v,syncCalendarRentalScheduleFromEvent=()=>{},facilityWallTimeToIso=(d,t)=>d+'T'+t+':00Z',createdByForSelectedCalendarOwner=()=> 'admin',cleanCreatedByCore=v=>v,calculateCalendarRentalTotalCents=()=>0,rentalHoursBetween=()=>1,normalizeRentalHours=v=>v,rentalPublicWindowPatch=()=>({}),openRecurringDeleteScopeDialog=async()=>document.querySelector('#calSeriesEditScope').value;
${slice('function normalizeTimeFieldValue(','function addDaysLocal(')}
${slice('function parseRecurringExclusions(','async function preflightRecurringRentals(')}
${slice('async function postRecurringRentalOperation(','function uidSeriesToken(')}
${slice('function collectCalendarRentalPayload(','function collectCalendarRentalSchedulePayload(')}
${slice('async function saveCalendarEvent(','async function deleteCalendarEvent(')}
${slice('async function deleteCalendarEvent(','function showCalError(')}
${slice('function showCalError(','\n}',)}
}
async function refreshCalendarPageAfterMutation(){const rows=await (await fetch('/fixture-state')).json();calendarEvents=rows;document.querySelector('#result').textContent=rows.map(r=>r.event_date+' '+r.event_start_time+'-'+r.event_end_time+' '+r.rental_status+' '+r.event_name).join(' | ');}
document.querySelector('#calEvRecurring').checked=true;document.querySelector('#calRecurringCount').disabled=false;document.querySelector('#calRecurringCount').value=4;document.querySelector('[data-rec-day="2"]').checked=true;document.querySelector('[data-rec-day="4"]').checked=true;document.querySelector('#calRecurringExclusions').value='2027-04-08';document.querySelector('#calSeriesEditScopeField').hidden=true;
document.addEventListener('input',()=>updateCalendarRecurringPreview(document));document.querySelector('#calModalSave').onclick=()=>saveCalendarEvent(document);document.querySelector('#cancelSeries').onclick=()=>deleteCalendarEvent(document);
document.querySelector('#edit').onclick=()=>{const r=calendarEvents.find(r=>r.rental_status==='confirmed');if(!r)return;const modal=document.querySelector('#calEventModal');modal.hidden=false;Object.assign(modal.dataset,{evId:r.id,rentalRequestId:r.id,seriesId:r.recurring_series_id,rentalLoaded:'true'});document.querySelector('#calEvRecurring').checked=false;document.querySelector('#calRecurringFields').hidden=true;document.querySelector('#calSeriesEditScopeField').hidden=false;document.querySelector('#calEvDate').value=r.event_date;document.querySelector('#calEvTitle').value=r.event_name;};updateCalendarRecurringPreview(document);refreshCalendarPageAfterMutation();
</script></body>`;
const server=http.createServer(async(req,res)=>{try{
 if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(path.join(root,'RORC App/app.css')));}
 if(req.url==='/fixture-state'){res.setHeader('Content-Type','application/json');return res.end(await sql(`select coalesce(json_agg(r),'[]') from (select id,event_name,event_date,event_start_time,event_end_time,rental_status,recurring_series_id from rental_requests where contact_name='Browser fixture series' order by event_date) r;`));}
 if(req.url==='/api/recurring-rentals'){let body='';for await(const part of req)body+=part;req.body=JSON.parse(body);res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};return handler(req,res);}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
 }catch(error){res.statusCode=500;res.end(error.message);}});
server.listen(8766,'127.0.0.1',()=>console.log('Fixture preview listening on http://127.0.0.1:8766'));
