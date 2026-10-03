const {test}=require('node:test');const assert=require('node:assert/strict');
const draft=require('../scripts/rorc-account-form-draft');
const scope={userId:'user',memberId:'account',route:'heaterForm'};
const field=(value,type='text')=>({value,type,tagName:'INPUT',checked:true});
test('switching retains form details but omits PIN, billing consent and responsible member IDs',()=>{
 const visited=[];const host={querySelectorAll(selector){visited.push(selector);return selector==='#thermostatTargetTemp'?[field('68')]:[];}};
 const saved=draft.capture(host,'heater',scope);assert.equal(saved.entries[0].value,'68');assert.ok(draft.validate(saved,scope));
 assert.equal(visited.some(selector=>/heaterPin|Responsible|cost-accepted|contact/i.test(selector)),false);
});
test('expired, revoked-account, different-login, other-route and injected drafts are discarded',()=>{
 const base={...scope,kind:'heater',entries:[],expiresAt:Date.now()+60000};
 for(const change of [{userId:'other'},{memberId:'revoked'},{route:'calendar'},{expiresAt:0},{expiresAt:Date.now()+9999999},{entries:[{selector:'#heaterPin',index:0,value:'1234',checked:false,button:false}]}])assert.equal(draft.validate({...base,...change},scope),null);
});
test('restore never submits a form and restores schedule inputs after segment controls',()=>{
 const calls=[];const fields={'[data-heater-timer-enabled]':{tagName:'BUTTON',click(){calls.push('segment');}},'#heaterTimerDuration':field('15')};
 draft.restore({querySelectorAll(selector){return [fields[selector]];}},{entries:[{selector:'#heaterTimerDuration',index:0,value:'60',button:false},{selector:'[data-heater-timer-enabled]',index:0,value:'',button:true}]});assert.deepEqual(calls,['segment']);assert.equal(fields['#heaterTimerDuration'].value,'60');
});
