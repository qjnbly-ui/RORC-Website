const test=require('node:test'),assert=require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
const {interpretAssistant,bookingDirective}=require('../api/_sms-assistant');
const {answer}=require('../.build/receptionist/public-assistant');
const questionOptions={classify:async()=>({intent:'simple_question',detail_level:'brief'}),answer:async()=> 'Fixture public answer.'};
test('SMS public questions share receptionist answers without booking interpretation',async()=>{
 let answered=0;const options={...questionOptions,answer:async(text,history,detail,route,config)=>{answered++;assert.equal(config.channel,'sms');return 'Membership fixture.';},interpretBooking:()=>{throw Error('must not propose booking');}};
 for(const text of ['What does membership cost?','Can I cancel a booking?','How do rental deposits work?'])assert.equal((await interpretAssistant(text,[],{},options)).reply,'Membership fixture.');
 assert.equal(answered,3);assert.equal(bookingDirective('Can I cancel my booking?'),false);assert.equal(bookingDirective('Please cancel my booking'),true);
});
test('private account requests never use phone recognition or PIN as authentication',async()=>{
 const result=await interpretAssistant('What is my account balance?',[],{phone:'+15415550100'},{});
 assert.match(result.reply,/sign in/i);assert.match(result.reply,/does not verify/);assert.equal(result.action,'clarify');assert.equal(result.assistantState.formSession,undefined);
});
test('membership form persists one field at a time and finishes with a review link',async()=>{
 let stored;const options={createFormDraft:async(formId,answers,phone)=>{stored={formId,answers,phone};return {url:'https://fixture.invalid/#draft='+'x'.repeat(43)};}};
 let result=await interpretAssistant('I want to join RORC',[],{phone:'+15415550100'},options);
 assert.match(result.reply,/Which membership/);
 for(const text of ['Full Facility','Fixture Member','fixture@example.invalid','USE THIS NUMBER','Fixture Address'])result=await interpretAssistant(text,[],{...result,phone:'+15415550100'},options);
 assert.equal(stored.formId,'membership');assert.equal(stored.answers.primaryPhone,'+15415550100');assert.equal(stored.answers.planId,'full_facility');assert.match(result.reply,/have not submitted/);assert.equal(result.assistantState.formSession,undefined);
});
test('questions interrupt guided forms without overwriting collected answers',async()=>{
 const state={formSession:{formId:'membership',fieldIndex:1,answers:{planId:'open_gym'}}};
 const result=await interpretAssistant('How much does it cost?',[],{assistantState:state},questionOptions);
 assert.equal(result.reply,'Fixture public answer.');assert.deepEqual(result.assistantState,state);
 const canceled=await interpretAssistant('cancel form',[],{assistantState:state},{});assert.deepEqual(canceled.assistantState,{});
});
test('rental forms require explicit year and unambiguous times; negative answers remain negative',async()=>{
 const session={formId:'rental',fieldIndex:6,answers:{}};
 for(const text of ['November 23','2027-02-30']){const result=await interpretAssistant(text,[],{assistantState:{formSession:session}},{});assert.equal(result.assistantState.formSession.fieldIndex,6);}
 const dated=await interpretAssistant('2027-04-06',[],{assistantState:{formSession:session}},{});assert.equal(dated.assistantState.formSession.answers.eventDate,'2027-04-06');
 const ambiguous=await interpretAssistant('12:30',[],{assistantState:{formSession:{...session,fieldIndex:7}}},{});assert.equal(ambiguous.assistantState.formSession.answers.eventStartTime,'12:30');
 const missing=await interpretAssistant('12',[],{assistantState:{formSession:{...session,fieldIndex:7}}},{});assert.equal(missing.assistantState.formSession.fieldIndex,7);
 const no=await interpretAssistant('NO IT WILL NOT',[],{assistantState:{formSession:{...session,fieldIndex:10}}},{});assert.equal(no.assistantState.formSession.answers.isPrivateEvent,'no');
});
test('booking clarifications retain booking path while public questions stay read-only',async()=>{
 const state={booking:true};let interpreted=0;
 const options={...questionOptions,interpretBooking:async()=>{interpreted++;return {action:'clarify',reply:'Confirm the year.'};}};
 await interpretAssistant('What is the rental cost?',[],{assistantState:state},options);assert.equal(interpreted,0);
 const result=await interpretAssistant('2027-04-06',[],{assistantState:state},options);assert.equal(interpreted,1);assert.equal(result.assistantState.booking,true);
});
test('staff handoff stops automatic conversation until assistant is requested again',async()=>{
 const handoff=await interpretAssistant('I want to talk to staff',[],{},{});assert.equal(handoff.action,'staff');
 const quiet=await interpretAssistant('Thanks',[],handoff,{});assert.equal(quiet.reply,'');
 const resumed=await interpretAssistant('AI assistant, what are memberships?',[],handoff,questionOptions);assert.equal(resumed.reply,'Fixture public answer.');
});
test('shared core uses deterministic live facts and marks stale information',async()=>{
 const snapshot={facility:{data:{success:true,activity:{roomTemperatureF:68}},freshness:'stale',savedAt:Date.now(),error:''},events:{data:null,freshness:'unavailable',savedAt:null,error:''},loadedAt:new Date().toISOString()};
 const reply=await answer('What is the temperature?',[],'brief',{live_data:'facility',live_fact:'temperature'},{channel:'sms',apiKey:'',liveSnapshot:snapshot});assert.match(reply,/68/);assert.match(reply,/recorded|latest|stale/i);
});
test('storage redacts prefill tokens and suppresses stale answers or human conversations',async()=>{
 process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
 const {handleBookingSms}=require('../api/_sms-booking-store');
 const original=global.fetch;let saved=[],newer=false,human=false;
 const id='33333333-3333-4333-8333-333333333333',token='x'.repeat(43);
 global.fetch=async(url,options={})=>{
  let rows=[];url=String(url);
  if(url.includes('staff_communication_threads?'))rows=[{ai_mode:'automatic',ai_revision:0,ai_paused_until:human?new Date(Date.now()+60000).toISOString():null}];
  else if(url.includes('consent?'))rows=[{consent_status:'opt_in'}];
  else if(url.includes('on_conflict'))rows=[{id}];
  else if(url.includes('select=id&phone'))rows=[{id:newer?'different':id}];
  else if(url.includes('staff_communication_messages?'))rows=human?[{id:'human'}]:[];
  else if(options.method==='PATCH'){saved.push(JSON.parse(options.body));rows=[{id}];}
  return {ok:true,json:async()=>rows};
 };
 const payload={From:'+15415550100',MessageSid:'SM'+'a'.repeat(32),Body:'Finish online'};
 const interpret=async()=>({action:'clarify',reply:`Review https://fixture.invalid/#draft=${token}`,assistantState:{}});
 try{
  assert.match(await handleBookingSms(payload,{interpret}),new RegExp(token));
  assert.equal(JSON.stringify(saved).includes(token),false);assert.match(saved[0].reply_text,/private link/);
  saved=[];newer=true;assert.equal(await handleBookingSms(payload,{interpret}),'');assert.equal(saved[0].status,'canceled');
  saved=[];newer=false;human=true;assert.equal(await handleBookingSms(payload,{interpret}),'');assert.equal(saved.length,0);
 }finally{global.fetch=original;}
});
