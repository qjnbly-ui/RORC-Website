const test=require('node:test'),assert=require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
const {conversationAiAllowed,updateConversationAi}=require('../api/_sms-conversation-settings');
const {pauseThreadForStaffReply}=require('../api/_staff-communications');
const handler=require('../api/communications');
const id='11111111-1111-4111-8111-111111111111';
const response=data=>({ok:true,json:async()=>data});
test('conversation eligibility requires a known allowed thread and an expired or absent pause',async()=>{
 const original=global.fetch;
 try{for(const [row,allowed] of [[null,false],[{ai_mode:'never'},false],[{ai_mode:'automatic',ai_paused_until:null},true],[{ai_mode:'automatic',ai_paused_until:new Date(Date.now()+60000).toISOString()},false],[{ai_mode:'automatic',ai_paused_until:new Date(Date.now()-60000).toISOString()},true],[{ai_mode:'automatic',ai_paused_until:'invalid'},false]]){global.fetch=async()=>response(row?[{ai_revision:0,...row}]:[]);assert.equal(await conversationAiAllowed('+15415550100'),allowed);}}finally{global.fetch=original;}
});
test('settings reject malformed inputs before any database write',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;throw Error('unexpected write');};
 const base={threadId:id,mode:'automatic',resumeAfterMinutes:20};
 try{for(const change of [{threadId:'bad'},{mode:'bad'},{resumeAfterMinutes:0},{resumeAfterMinutes:'15'},{resumeAfterMinutes:10081},{resumeNow:'true'}])await assert.rejects(updateConversationAi({...base,...change}));assert.equal(calls,0);}finally{global.fetch=original;}
});
test('manager settings use the atomic service RPC and ordinary members cannot change them',async()=>{
 const original=global.fetch;let role='Account Manager',writes=0;
 global.fetch=async(url,options={})=>{url=String(url);if(url.includes('/auth/'))return response({id});if(url.includes('account_members?'))return response([{id,account_type:role}]);assert.match(url,/rpc\/set_sms_conversation_ai$/);const body=JSON.parse(options.body);assert.equal(body.thread_id,id);assert.equal(body.resume_now,true);writes++;return response({ai_mode:'automatic',ai_resume_after_minutes:15,ai_paused_until:null});};
 async function invoke(authorization='Bearer fixture'){const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({method:'PATCH',headers:{authorization},body:{action:'set_ai',threadId:id,mode:'automatic',resumeAfterMinutes:15,resumeNow:true}},res);return res;}
 try{let result=await invoke();assert.equal(result.code,200);assert.equal(result.body.ai.aiResumeAfterMinutes,15);role='Rental Account';assert.equal((await invoke()).code,403);assert.equal((await invoke('')).code,401);assert.equal(writes,1);}finally{global.fetch=original;}
});
test('staff reply pauses the selected conversation using its configured duration before sending',async()=>{
 let saved;await pauseThreadForStaffReply('+15415550100',async(url,options={})=>{if(options.method==='PATCH'){saved=JSON.parse(options.body);return response([]);}return response([{id,ai_resume_after_minutes:60}]);});
 const minutes=(Date.parse(saved.ai_paused_until)-Date.now())/60000;assert.ok(minutes>59.9&&minutes<=60);
});
test('a pause followed by resume invalidates a reply already being generated',async()=>{
 const {handleBookingSms}=require('../api/_sms-booking-store');
 const original=global.fetch;let revision=0,saved;
 global.fetch=async(url,options={})=>{url=String(url);if(url.includes('consent?'))return response([{consent_status:'opt_in'}]);if(url.includes('staff_communication_threads?'))return response([{ai_mode:'automatic',ai_paused_until:null,ai_revision:revision}]);if(url.includes('on_conflict'))return response([{id}]);if(url.includes('select=id&phone'))return response([{id}]);if(options.method==='PATCH'){saved=JSON.parse(options.body);return response([{id}]);}return response([]);};
 try{const reply=await handleBookingSms({From:'+15415550100',MessageSid:'SM'+'b'.repeat(32),Body:'Fixture question'},{interpret:async()=>{revision=2;return {action:'clarify',reply:'An outdated answer.'};}});assert.equal(reply,'');assert.equal(saved.status,'canceled');}finally{global.fetch=original;}
});
