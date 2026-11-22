const {empty, normalize, acceptance, decline, literalPlan, semanticPlan, requestsFacilityAction, checkoutTopic} = require('./_sms-facility-language');
const {startThermostatRuntime, changeThermostatTemperature, notifyThermostatOn, getAutomationConfig} = require('./heater-on-sequence');
const {executeHeaterOff} = require('./heater-off-sequence');
const {loadThermostatStatus} = require('./thermostat-status');
const money = cents => '$' + (cents / 100).toFixed(2);
const heatDollarsPerHour = 13;
const cleanLabel = label => label.replace(/ · #+\s*/g, ' · #');
const accountOptions = rows => rows.map((row,i)=>(i+1)+'. '+cleanLabel(row.label)).join('\n');
const say = (reply, facility) => ({action:'clarify', reply, assistantState:facility ? {facility} : {}});
const clarify = 'What would you like me to do with your check-in or the gym heater?';
const rpc = (rest, name, args) => rest('rpc/'+name, {method:'POST', body:JSON.stringify(args)});

function selection(text, rows) {
  const clean=normalize(text).replace(/[.,!?]/g,' ');
  const ordinal=clean.match(/^(?:(?:use|choose|pick) )?(?:the |account |option )?(first|second|third|fourth|\d+)(?:st|nd|rd|th)?(?: one| account| option)?(?: please)?$/);
  if (ordinal) {
    const index=Number(ordinal[1]) || ['first','second','third','fourth'].indexOf(ordinal[1])+1;
    if(rows[index-1]) return rows[index-1];
  }
  const words=clean.match(/[a-z0-9]+/g) || [];
  const matches=rows.filter(row=>row.label.toLowerCase().split(' · ').some(part=>{
    const tokens=part.match(/[a-z0-9]+/g)||[];
    return tokens.length && tokens.every(word=>words.includes(word));
  }));
  return matches.length===1 ? matches[0] : null;
}
function describe(plan, memberName) {
  const actions=[];
  if(plan.attendance==='in') actions.push('check you in under '+memberName);
  if(plan.heat==='start' || plan.heat==='adjust') {
    let setting='set the heater to '+plan.temperature+'°F';
    if(plan.minutes) setting+=' for '+plan.minutes+(plan.minutes===1?' minute':' minutes');
    else if(plan.until) setting+=' until '+plan.until+' Pacific';
    else if(plan.heat==='start') setting+=' without a timer';
    actions.push(setting);
  }
  if(plan.heat==='off') actions.push('turn off the heater');
  if(plan.attendance==='out') actions.push('check you out');
  return actions.join(' and ');
}
const checkoutAnswers = {
  other_checkout: 'By text, I can sign you out of your own visit. To sign out another member, an account manager can open Currently Signed In in the RORC app and tap Sign Out beside their name.',
  self_checkout: 'Yes. Text me “sign me out” and I’ll confirm which visit to close.'
};
async function prepareFacility(text, context, deps) {
  const pending=context.assistantState?.facility;
  const clean=normalize(text);
  const topic=checkoutTopic(clean);
  if(topic) return say(checkoutAnswers[topic]);
  if(pending && decline.test(clean)) return say('Okay, I canceled that request.');
  if(pending?.stage==='confirm' && acceptance.test(clean))
    return {action:'facility_accept', plan:pending};
  let chosen=null;
  if(pending?.choices) chosen=selection(text,pending.choices);
  const switchAccount=pending && !chosen && /\b(?:different|other|switch|change)\b.*\baccount\b|\buse (?:my|the) .+ account\b/i.test(text);
  if(switchAccount || chosen) {
    const rows=await deps.members(context.phone);
    if(switchAccount && !selection(text,rows))
      return say('Which account should I use?\n'+accountOptions(rows),
        {...pending,member:null,stage:'account',choices:rows.map(({member_id,label})=>({member_id,label}))});
    chosen=chosen || selection(text,rows);
  }
  let changes=chosen || (pending?.stage==='details' && acceptance.test(clean)) ? {} : literalPlan(text, pending);
  if(!changes) {
    const interpreted=await (deps.interpret || semanticPlan)(text,pending).catch(()=>null);
    if(interpreted?.kind==='other_checkout' || interpreted?.kind==='self_checkout')
      return say(checkoutAnswers[interpreted.kind]);
    if(interpreted?.kind==='accept' && pending?.stage==='confirm' && clean.length<=120 &&
        !/[?0-9]|\b(?:but|if|unless|instead|except|only|wait|no|not|don.t|later|change|actually|ignore|maybe|tomorrow|account)\b/i.test(clean))
      return {action:'facility_accept',plan:pending};
    if(interpreted?.kind==='decline' && pending) return say('Okay, I canceled that request.');
    if(interpreted?.kind==='plan') changes=interpreted.changes;
    else if(interpreted?.kind==='clarify' || pending) return say(
      pending?.stage==='account' ? 'Which account do you mean?\n'+accountOptions(pending.choices) :
      pending?.stage==='confirm' ? 'I have not applied that request. Would you like to go ahead as quoted, change a detail, or cancel?' : clarify,
      // Never leave a previous quote executable after an ambiguous edit.
      pending?.stage==='confirm' ? {...pending,stage:'details'} : pending);
    else if(requestsFacilityAction(text)) return say(clarify);
    else return null;
  }
  const plan={...empty,...pending,...changes};
  if(!pending && plan.heat==='none' && plan.attendance==='none') return requestsFacilityAction(text) ? say(clarify) : null;
  if(changes.minutes!=null) plan.until=null;
  if(changes.until!=null) plan.minutes=null;
  if(plan.heat==='off' || plan.heat==='none') Object.assign(plan,{temperature:null,minutes:null,until:null});
  if(plan.attendance==='out' && ['start','set','adjust'].includes(plan.heat)) return say('Do you want to check out or use the heater?');
  const rows=await deps.members(context.phone);
  if(!rows.length) return say('I couldn’t match this number to a RORC member. Check the phone number on your member profile.');
  const selectedId=chosen?.member_id || plan.member;
  let member=rows.find(row=>row.member_id===selectedId);
  if(!member && rows.length===1 && !selectedId) member=rows[0];
  if(!member) {
    const choices=rows.map(({member_id,label})=>({member_id,label}));
    return say('Which account should I use?\n'+accountOptions(choices),
      {...plan,stage:'account',member:null,choices});
  }
  delete plan.choices;
  plan.member=member.member_id;
  const snapshot=await deps.preview(context.phone,plan.member);
  if(!snapshot) return say('I couldn’t verify that account for this number.');
  if(plan.heat==='set') plan.heat=snapshot.runtime ? 'adjust' : 'start';
  if(plan.attendance==='in' && !snapshot.canEnter) return say('This account cannot check in at this time.');
  if(['start','adjust'].includes(plan.heat) && (!snapshot.canHeat || !snapshot.enabled)) return say('Heat is unavailable for this account.');
  if(plan.heat==='start' && snapshot.runtime) return say('A thermostat session is already running.');
  if(['adjust','off'].includes(plan.heat) && (!snapshot.runtime || !snapshot.canControl))
    return say(snapshot.runtime ? 'This account cannot control the active thermostat session.' : 'There is no active heater session to change.');
  if(['start','adjust'].includes(plan.heat) && (!Number.isInteger(plan.temperature) || plan.temperature<45 || plan.temperature>80))
    return say('What temperature would you like, between 45 and 80°F?',{...plan,temperature:null,stage:'temperature'});
  if(plan.minutes!=null && (!Number.isInteger(plan.minutes) || plan.minutes<1 || plan.minutes>=1440) ||
     plan.until!=null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(plan.until))
    return say('How long should the heater run? Choose a duration under 24 hours.',{...plan,stage:'details',minutes:null,until:null});
  if(plan.heat==='adjust' && (plan.minutes||plan.until)) return say('The heater is already running. You can change its temperature by text or edit its timer in the app.');
  if(plan.heat==='none' && plan.attendance==='none') return say(clarify);
  Object.assign(plan,{stage:'confirm',revision:context.revision,account:snapshot.account,runtime:snapshot.runtime,month:snapshot.month,monthly:snapshot.monthly,owed:snapshot.owed});
  if(plan.heat==='start' && ![plan.monthly,plan.owed].every(Number.isSafeInteger)) return say('I couldn’t retrieve the monthly heat balance. Please try again.');
  const [fullName, , number] = cleanLabel(member.label).split(' · ');
  const accountName = rows.length > 1 && number ? fullName+' (account '+number+')' : fullName;
  const greeting = 'Hey '+fullName.trim().split(/\s+/)[0]+', ';
  const action = describe(plan, accountName);
  const accountSuffix = plan.attendance==='in' ? '' : ' for '+accountName;
  if(plan.heat!=='start') return say(greeting+'should I '+action+accountSuffix+'?',plan);

  const balance = plan.monthly===plan.owed
    ? 'your heat balance for this month is '+money(plan.owed)+'.'
    : 'you’ve used '+money(plan.monthly)+' in heat this month and have '+money(plan.owed)+' left to pay.';
  let rate = 'Heat is $'+heatDollarsPerHour+' an hour';
  if(plan.minutes) {
    const estimate = money(Math.ceil(plan.minutes * heatDollarsPerHour * 100 / 60));
    rate += ', so '+plan.minutes+(plan.minutes===1?' minute':' minutes')+' would add about '+estimate;
  }
  return say(greeting+balance+' '+rate+'. Should I '+action+accountSuffix+'?',plan);
}

async function equipmentReady(heat, rest) {
  if(heat==='none') return true;
  const status=await loadThermostatStatus('heat', process.env.ECOBEE_HEATER_THERMOSTAT_ID || process.env.ECOBEE_THERMOSTAT_ID);
  if(status.connected!==true || status.stale || status.error) return false;
  if(heat!=='start') return true;
  const fan=/fan|blower/i.test(status.equipmentStatus) && status.desiredFanMode!=='on';
  if(status.hvacMode==='off' && (status.isHeating || fan)) return false;
  const recent=await rest('heater_use_entries?select=end_at&system_type=eq.heat&end_at=gt.'+
    encodeURIComponent(new Date(Date.now()-300000).toISOString())+'&order=end_at.desc&limit=1');
  return !recent.length || (status.hvacMode==='off' && !status.isHeating && !fan &&
    Date.parse(status.connectionCheckedAt)>Date.parse(recent[0].end_at));
}
async function executeFacility(plan, context, deps) {
  const ready=await deps.ready(plan.heat).catch(()=>false);
  const result=await deps.accept(context.previousId,context.draftId,ready);
  if(!result) return say('That request expired or changed. Please tell me what you’d like to do again.');
  const replies=[result.attendance];
  if(result.problem) replies.push(result.problem);
  else if(plan.heat!=='none') {
    const entry={id:result.entry,systemType:'heat',startAt:result.startAt,targetTemperatureF:result.priorTemperature};
    if(!entry.id) throw Error('Missing authorized runtime');
    try {
      if(plan.heat==='off') {
        const stopped=await deps.stop({requestedSystemType:'heat',heaterUseEntryId:entry.id,closeEntry:true});
        replies.push(stopped.duplicate?'That heater session has already ended.':'Ecobee accepted the heater shutoff.');
        if(plan.attendance==='out') {
          try { await deps.checkOut(plan.member,context.acceptedAt); replies.push('You are checked out.'); }
          catch { replies.push('I could not confirm your check-out. Please check the app.'); }
        }
      } else {
        const args={entry,targetTemperatureF:plan.temperature};
        if(plan.heat==='adjust') await deps.adjust(args);
        else {
          await deps.start(args);
          await deps.markStarted(context.previousId);
        }
        replies.push('Ecobee accepted the '+plan.temperature+'°F setting'+(plan.minutes?' for '+plan.minutes+' minutes':plan.until?' until '+plan.until+' Pacific':'')+'.');
        if(plan.heat==='start') await deps.notify(entry,plan).catch(()=>replies.push('The usual heater statement could not be delivered.'));
      }
    } catch { replies.push('I could not confirm the heater change. Check the thermostat status in the app before retrying.'); }
  }
  return say(replies.filter(Boolean).join(' '));
}
function facilityServices(rest) {
  return {
    members:sender=>rpc(rest,'sms_facility_members',{sender}),
    preview:(sender,actor)=>rpc(rest,'sms_facility_preview',{sender,actor}),
    ready:heat=>equipmentReady(heat,rest),
    accept:(quote_id,message_id,equipment_ready)=>rpc(rest,'accept_sms_facility_action',{quote_id,message_id,equipment_ready}),
    start:startThermostatRuntime,adjust:changeThermostatTemperature,stop:executeHeaterOff,
    markStarted:id=>rest('sms_booking_drafts?id=eq.'+encodeURIComponent(id)+'&status=eq.confirmed',{
      method:'PATCH',body:JSON.stringify({resolved_command:{equipment:'accepted'}})
    }),
    notify:async(entry,plan)=>{
      const result=await notifyThermostatOn({settings:await getAutomationConfig('heater_on'),entry,systemType:'heat',targetTemperatureF:plan.temperature,memberIds:[plan.member]});
      if(result.warnings?.length) throw Error('Statement delivery failed');
    },
    checkOut:(member,at)=>rest('timesheet_entries?member_or_guest=eq.Member&member_id=eq.'+encodeURIComponent(member)+'&signed_out_at=is.null&signed_in_at=lte.'+encodeURIComponent(at),
      {method:'PATCH',body:JSON.stringify({signed_out_at:at})})
  };
}
module.exports={prepareFacility,executeFacility,facilityServices};
