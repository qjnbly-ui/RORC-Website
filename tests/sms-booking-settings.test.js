const test=require('node:test'),assert=require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
const handler=require('../api/sms-preferences');
const {getSmsBookingSettings}=require('../api/_sms-booking-settings');
const manager='11111111-1111-4111-8111-111111111111';
const response=data=>({ok:true,json:async()=>data});
async function invoke(method,body={},authorization='Bearer fixture'){const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({method,headers:{authorization},body},res);return res;}
test('manager toggle persists shared state, reloads accurately, and rejects non-booleans',async()=>{
 const original=global.fetch;let config={enabled:false},writes=0;
 global.fetch=async(url,options={})=>{url=String(url);if(url.includes('/auth/'))return response({id:manager});if(url.includes('/account_members?'))return response([{id:manager,account_type:'Account Manager'}]);if(url.includes('/automation_settings?')){if(options.method==='POST'){const body=JSON.parse(options.body);assert.equal(body.id,'sms_booking_ai');assert.equal(body.config.updated_by_member_id,manager);config=body.config;writes++;}return response([{config}]);}return response([]);};
 try{assert.equal((await invoke('GET')).body.bookingAi.enabled,false);assert.equal((await invoke('PATCH',{action:'set_booking_ai',enabled:true})).body.bookingAi.enabled,true);assert.equal((await invoke('GET')).body.bookingAi.enabled,true);assert.equal((await invoke('PATCH',{action:'set_booking_ai',enabled:false})).body.bookingAi.enabled,false);assert.equal((await invoke('PATCH',{action:'set_booking_ai',enabled:'true'})).code,400);assert.equal(writes,2);}finally{global.fetch=original;}
});
test('non-managers and missing auth cannot change the shared SMS setting',async()=>{
 const original=global.fetch;let writes=0;global.fetch=async(url,options={})=>{if(options.method==='POST')writes++;return response(String(url).includes('/auth/')?{id:manager}:[{id:manager,account_type:'Rental Account'}]);};
 try{assert.equal((await invoke('PATCH',{action:'set_booking_ai',enabled:true},'')).code,401);assert.equal((await invoke('PATCH',{action:'set_booking_ai',enabled:true})).code,403);assert.equal((await invoke('GET')).code,403);assert.equal(writes,0);}finally{global.fetch=original;}
});
test('missing or malformed settings stay off even with the legacy environment flag on',async()=>{
 const original=global.fetch,previous=process.env.RORC_SMS_BOOKING_AI_ENABLED;process.env.RORC_SMS_BOOKING_AI_ENABLED='true';
 try{for(const data of [[],[{config:{enabled:'true'}}],[{config:{enabled:false}}]]){global.fetch=async()=>response(data);assert.equal((await getSmsBookingSettings()).enabled,false);}}finally{global.fetch=original;if(previous===undefined)delete process.env.RORC_SMS_BOOKING_AI_ENABLED;else process.env.RORC_SMS_BOOKING_AI_ENABLED=previous;}
});
