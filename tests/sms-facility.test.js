const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareFacility,executeFacility}=require('../api/_sms-facility');
const {literalPlan,semanticPlan}=require('../api/_sms-facility-language');

const member={member_id:'member-a',label:'Jane · Active Membership · #100'};
const other={member_id:'member-b',label:'Jane · Special Access Account · #205'};
function fixture(overrides={}) {
  const calls=[];
  const snapshot={account:'acct',month:'2026-11',monthly:2850,owed:1250,canEnter:true,canHeat:true,enabled:true,runtime:null,canControl:false};
  return {calls,snapshot,async members(){return [member];},async preview(){return snapshot;},
    interpret:async()=>null,ready:async()=>true,
    accept:async(...args)=>{calls.push(['accept',...args]);return {entry:'entry',attendance:'You are checked in.'};},
    markStarted:async()=>{},start:async args=>calls.push(['start',args]),adjust:async args=>calls.push(['adjust',args]),
    stop:async args=>{calls.push(['stop',args]);return {success:true};},
    checkOut:async(...args)=>calls.push(['checkOut',...args]),notify:async()=>calls.push(['notify']),...overrides};
}
const ctx={phone:'+15415550101',revision:12,previousId:'quote',draftId:'inbound',acceptedAt:'2026-11-20T20:00:00Z'};
const turn=(text,deps,last)=>prepareFacility(text,{...ctx,...last},deps);
const confirmed=async (text,deps,last)=>{
  const accepted=await turn(text,deps,last);
  assert.equal(accepted.action,'facility_accept');
  return executeFacility(accepted.plan,ctx,deps);
};

for (const [text,temp,minutes,until] of [
 ['Sign me in and warm the gym to 68 for an hour.',68,60,null],
 ['Could you warm the room up to 68 for half an hour?',68,30,null],
 ['Please check me in and please heat the building to sixty-seven for 45 minutes.',67,45,null],
 ['Preheat the gym to 70 for one hour',70,60,null],
 ['Sign me in and set the gym to 68 for an hour',68,60,null],
 ['Could you check me in and warm up the gym to sixty-eight for half an hour?',68,30,null],
 ['check me in and turn the heater on at 70 for ninety minutes',70,90,null],
 ['Set the thermostat to  sixty-six  for 1.5 hours',66,90,null],
 ['please heat the gym to 64 until 9:15 pm',64,null,'21:15'],
 ['would you start the heater at  seventy-two?',72,null,null]
]) test(text,async()=>{
  const deps=fixture(),result=await turn(text,deps),p=result.assistantState.facility;
  assert.deepEqual([p.heat,p.temperature,p.minutes,p.until],['start',temp,minutes,until]);
  assert.match(result.reply,/\$28\.50 in heat this month and have \$12\.50 left to pay/);
  assert.match(result.reply,/\$13 an hour/);assert.equal(deps.calls.length,0);
});

for (const text of ['yes','Sure!','Sounds good','go right ahead','yeah, please','Okay, thanks','please do','that works for me','yep','I agree','let’s do it','absolutely']) test('accepts '+text,async()=>{
  const deps=fixture(),q=await turn('check me in and set the heat to 68',deps);
  const done=await confirmed(text,deps,q);
  assert.match(done.reply,/checked in.*68°F/);
  assert.deepEqual(deps.calls.map(c=>c[0]),['accept','start','notify']);
});
test('shared number selects member and temperature over separate turns; a changed number cannot reuse the selection',async()=>{
  const deps=fixture({members:async()=>[member,other]});
  let q=await turn('sign me in and start the heat',deps);
  assert.match(q.reply,/Which account/); assert.doesNotMatch(q.reply,/charged/);
  q=await turn('the second one please',deps,q);
  assert.match(q.reply,/What temperature/);
  q=await turn('sixty eight',deps,q);
  assert.equal(q.assistantState.facility.member,'member-b');
  assert.match(q.reply,/#205/);
  q=await turn('Actually, make that 65',deps,q);
  assert.match(q.reply,/65°F/);assert.deepEqual(deps.calls,[]);
  q=await turn('use a different account',deps,q);
  q=await turn('use my active membership',deps,q);
  assert.match(q.reply,/#100/);
  deps.members=async()=>[];
  const failed=await turn('68',deps,q);
  assert.match(failed.reply,/match this number/);
});
test('unknown, prohibited, conditional and unsupported instructions cannot execute',async()=>{
  const deps=fixture(),q=await turn('set the gym to 68',deps);
  for(const text of ['yes but only if it’s free','yes, 72 instead','no thank you','I might','What is my balance?','yes?','not yet','yes, use my other account']) {
    const result=await turn(text,deps,q);assert.notEqual(result?.action,'facility_accept',text);
  }
  for(const text of ['what does heat cost?','If I sign in tomorrow, can I use the heater?','yes','How do I turn on the heater?'])
    assert.equal(await turn(text,deps),null);
  assert.deepEqual(deps.calls,[]);
});
test('permissions, balances, temperature and timer validation before acceptance',async()=>{
  const deps=fixture();
  for(const [field,text,match] of [['canEnter','check me in',/cannot check in/],['canHeat','set the gym to 68',/unavailable/],['enabled','set the gym to 68',/unavailable/]]) {
    deps.snapshot[field]=false;assert.match((await turn(text,deps)).reply,match);deps.snapshot[field]=true;
  }
  for(const temp of [0,44,81,900]) assert.match((await turn('set the gym to '+temp,deps)).reply,/45 and 80/);
  for(const hours of [0,24]) assert.match((await turn('set the gym to 68 for '+hours+' hours',deps)).reply,/under 24 hours/);
  deps.snapshot.monthly=null;assert.match((await turn('set the gym to 68',deps)).reply,/retrieve/);
  assert.deepEqual(deps.calls,[]);
});
test('a changed temperature or account is quoted again before any charge',async()=>{
  const deps=fixture(),q=await turn('set the heat to 68 for an hour',deps);
  const edit=await turn('make it 70',deps,q);
  assert.equal(edit.assistantState.facility.minutes,60);
  assert.match(edit.reply,/70°F/);assert.deepEqual(deps.calls,[]);
  const declined=await turn('never mind',deps,edit);
  assert.deepEqual(declined.assistantState,{});
});
test('offline still reports the committed check-in; stale quotes and failed commands never report success',async()=>{
  const deps=fixture(),q=await turn('check me in and start the heater at 68',deps);
  deps.ready=async()=>false;
  deps.accept=async(a,b,ready)=>{assert.equal(ready,false);return {attendance:'You are checked in.',problem:'The thermostat is offline.'};};
  assert.match((await confirmed('sure',deps,q)).reply,/checked in.*offline/);
  deps.accept=async()=>null;
  assert.match((await confirmed('sure',deps,q)).reply,/expired or changed/);
  deps.accept=async()=>({entry:'r',attendance:'You are checked in.'});
  deps.start=async()=>{throw Error('Ecobee failure');};
  const failed=await confirmed('sure',deps,q);
  assert.match(failed.reply,/checked in.*could not confirm/);assert.doesNotMatch(failed.reply,/accepted/);
  assert.deepEqual(deps.calls,[]);
});
test('an existing session can be adjusted or stopped and checked out, scoped to its authorized runtime',async()=>{
  const deps=fixture();
  Object.assign(deps.snapshot,{runtime:'r',system:'heat',canControl:false});
  assert.match((await turn('turn it down to 65',deps)).reply,/cannot control/);
  deps.snapshot.canControl=true;
  const adjust=await turn('turn it down to 65',deps);
  assert.equal(adjust.assistantState.facility.runtime,'r');
  await confirmed('okay',deps,adjust);
  assert.equal(deps.calls.some(c=>c[0]==='adjust'),true);
  const stop=await turn('please shut the heater off and sign me out',deps);
  await confirmed('go ahead',deps,stop);
  assert.deepEqual(deps.calls.slice(-2).map(c=>c[0]),['stop','checkOut']);
  deps.calls.length=0;deps.stop=async()=>{throw Error('unavailable');};
  assert.match((await confirmed('go ahead',deps,stop)).reply,/could not confirm/);
  assert.ok(!deps.calls.some(c=>c[0]==='checkOut'));
});
test('structured interpretation can understand indirect requests and nonliteral agreement but cannot alter the approved command',async(t)=>{
  t.mock.method(global,'fetch',async(url,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.response_format.json_schema.strict,true);
    assert.match(body.messages[0].content,/untrusted/);
    return Response.json({choices:[{message:{content:JSON.stringify({kind:'plan',attendance:'in',heat:'set',temperature:67,minutes:45,until:null,clearTimer:false})}}]});
  });
  const old=process.env.GROQ_API_KEY;process.env.GROQ_API_KEY='fixture';
  t.after(()=>{if(old===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=old;});
  const deps=fixture({interpret:semanticPlan});
  const q=await turn('Mark me here and warm the place to 67 for three quarters of an hour',deps);
  assert.match(q.reply,/check you in under Jane and set the heater to 67°F for 45 minutes/);
  deps.interpret=async()=>({kind:'accept',changes:{temperature:80}});
  const accepted=await turn('That arrangement suits me perfectly',deps,q);
  assert.equal(accepted.plan.temperature,67);
  assert.notEqual((await turn('sure, but only if free',deps,q)).action,'facility_accept');
});
test('interrupted starts are recovered at zero runtime; failed shutdown stays eligible for retry',async()=>{
  const {recoverUnconfirmedSmsStarts}=require('../api/dispatch-thermostat-timers');
  const writes=[],stops=[];
  const date='2026-11-19T20:00:00.000Z';
  const rest=async(path,options)=>{
    if(options){writes.push(path);return;}
    const params=new URLSearchParams(path.split('?')[1]);
    assert.equal(params.get('resolved_command'),'is.null');
    assert.equal(params.get('intent->assistantState->facility->>heat'),'eq.start');
    return [{id:'quote',result:{entry:'session',startAt:date}}];
  };
  await recoverUnconfirmedSmsStarts(rest,async args=>stops.push(args));
  assert.equal(stops[0].endAt,date);assert.equal(stops[0].heaterUseEntryId,'session');assert.equal(writes.length,1);
});

test('an unparsed control request stays out of public temperature lookup even if the interpreter is unavailable or misclassifies it',async()=>{
  for(const interpret of [async()=>null,async()=>({kind:'other'}),async()=>{throw Error('timeout');},async()=>({kind:'plan',changes:{heat:'none',attendance:'none'}})]) {
    const deps=fixture({interpret});
    for(const text of ['Can you crank the heat a bit?', 'Sign me in and take the chill off the place', 'Please kick the heater on for a while']) {
      const result=await turn(text,deps);
      assert.equal(result.action,'clarify');
      assert.match(result.reply,/check-in or the gym heater/);
      assert.deepEqual(result.assistantState,{});
    }
    for(const text of ['What temperature is the gym?', 'How do I turn on the heater?', 'Can you tell me how warm the gym is?', 'Is the gym warm enough to check in?'])
      assert.equal(await turn(text,deps),null);
    assert.deepEqual(deps.calls,[]);
  }
});

test('single account quotes the name, equal balances once and the estimated timed charge',async()=>{
  const deps=fixture({members:async()=>[{member_id:'member-a',label:'Quentin Nichols · Account Manager · ##1'}]});
  Object.assign(deps.snapshot,{monthly:3650,owed:3650});
  const q=await turn('sign me in and set the gym to 68 for 15 minutes',deps);
  assert.equal(q.reply,'Hey Quentin, your heat balance for this month is $36.50. Heat is $13 an hour, so 15 minutes would add about $3.25. Should I check you in under Quentin Nichols and set the heater to 68°F for 15 minutes?');
  const noTimer=await turn('set the gym to 68',deps);
  assert.doesNotMatch(noTimer.reply,/would add/);
  assert.match(noTimer.reply,/without a timer/);
});
test('shared account choices normalize stored account numbers',async()=>{
  const deps=fixture({members:async()=>[member,{...other,label:'Jane · Special Access Account · ##205'}]});
  const menu=await turn('check me in',deps);
  assert.match(menu.reply,/\n2\. Jane · Special Access Account · #205/);
  assert.doesNotMatch(menu.reply,/##/);
  const quote=await turn('the second one',deps,menu);
  assert.match(quote.reply,/under Jane \(account #205\)/);
});

test('capability questions defer to the answer model without touching attendance',async()=>{
  const deps=fixture({members:async()=>assert.fail('unexpected member lookup'),interpret:async()=>({kind:'capability'})});
  for(const text of ['If someone else was signed in, could I have you sign them out','Could I check another member out?', 'Please sign him out'])
    assert.equal(await turn(text,deps),null);
  assert.deepEqual(deps.calls,[]);
});
