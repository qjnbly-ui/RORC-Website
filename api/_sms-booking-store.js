const crypto=require('node:crypto');
const {normalizePhone,hasConsent}=require('./_rorc-sms');
const {interpretAssistant}=require('./_sms-assistant');
const {prepareFacility,executeFacility,facilityServices}=require('./_sms-facility');
const URL=(process.env.SUPABASE_URL || 'https://aedvuofiodtsgijcxyqx.supabase.co').replace(/\/+$/,'');
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const hash=(token)=>crypto.createHash('sha256').update(String(token)).digest('hex');
async function rest(path,options={}) {
 const response=await fetch(`${URL}/rest/v1/${path}`,{...options,headers:{apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':'application/json',...options.headers}});
 const body=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(body.message || 'SMS booking storage unavailable.'),{status:response.status,code:body.code});return body;
}
async function cancelPhoneDrafts(phone) {const normalized=normalizePhone(phone);if(normalized)await rest(`sms_booking_drafts?phone_e164=eq.${encodeURIComponent(normalized)}&status=in.(processing,ready,clarification)`,{method:'PATCH',body:JSON.stringify({status:'canceled'})});}
async function hasFacilityConversation(phone, sid) {
 const normalized=normalizePhone(phone);
 if(!normalized) return false;
 // A redelivered YES that belonged to a facility turn must never opt someone
 // back in after a later STOP.
 if(/^SM[a-zA-Z0-9]{32}$/.test(String(sid || ''))) {
  const seen=await rest(`sms_booking_drafts?select=id&phone_e164=eq.${encodeURIComponent(normalized)}&message_sid=eq.${encodeURIComponent(sid)}&limit=1`);
  if(seen.length) return true;
 }
 if(!await hasConsent(normalized)) return false;
 const rows=await rest(`sms_booking_drafts?select=status,intent,expires_at&phone_e164=eq.${encodeURIComponent(normalized)}&order=created_at.desc&limit=1`);
 const last=rows[0];
 return last?.status==='clarification' && Date.parse(last.expires_at)>Date.now() && Boolean(last.intent?.assistantState?.facility);
}
async function handleBookingSms(payload,options={}) {
 const phone=normalizePhone(payload.From),sid=String(payload.MessageSid || payload.SmsMessageSid || '');
 if(!phone||!/^SM[a-zA-Z0-9]{32}$/.test(sid))throw new Error('Invalid SMS identity.');
 if(!await hasConsent(phone))return ''; // STOP/START/HELP remain the ingress authority.
 const initialPolicy=await require('./_sms-conversation-settings').conversationAiSnapshot(phone);
 if(!initialPolicy.allowed)return '';
 const reserved=await rest('sms_booking_drafts?on_conflict=message_sid',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({message_sid:sid,phone_e164:phone,message_body:String(payload.Body || '').slice(0,1500),status:'processing',expires_at:new Date(Date.now()+20*60*1000).toISOString()})});
 if(!reserved.length)return ''; // Retries cannot send or execute twice.
 const draft=reserved[0];
 let executingFacility=false;
 try {
  const rows=await rest(`sms_booking_drafts?select=message_body,reply_text,intent,id,status&phone_e164=eq.${encodeURIComponent(phone)}&id=neq.${draft.id}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&order=created_at.desc&limit=6`);
  const prior=rows[0];
  const previous=['clarification','staff','ready'].includes(prior?.status) ? prior.intent || {} : {};
  const context={...previous,phone,revision:initialPolicy.revision};
  const services=options.facility || facilityServices(rest);
  const history=rows.filter(row=>!row.intent?.facilityTurn && !row.intent?.assistantState?.facility).reverse().flatMap(row=>[{role:'user',content:row.message_body},{role:'assistant',content:String(row.reply_text || '')}]);
  const text=String(payload.Body || '');
  const state=previous.assistantState || {};
  const handoff=/\b(?:talk|speak|connect)\b.{0,40}\b(?:staff|human|person|quentin)\b|^staff please/i.test(text);
  let intent;
  if(!options.interpret && !state.handoff && !state.formSession && !handoff) {
   intent=await prepareFacility(text,context,services);
   if(intent) intent.facilityTurn=true;
  }
  if(!intent) intent=await (options.interpret || interpretAssistant)(text,history,context);
  // A newer text supersedes a slow answer; a staff reply pauses AI for its configured period.
  // These reads also fail closed when conversation state cannot be verified.
  const latest=await rest(`sms_booking_drafts?select=id&phone_e164=eq.${encodeURIComponent(phone)}&order=created_at.desc&limit=1`);
  const currentPolicy=await require('./_sms-conversation-settings').conversationAiSnapshot(phone);
  const allowed=currentPolicy.allowed&&String(currentPolicy.revision)===String(initialPolicy.revision);
  if((latest[0]&&latest[0].id!==draft.id)||!allowed){
   await rest(`sms_booking_drafts?id=eq.${draft.id}&status=eq.processing`,{method:'PATCH',body:JSON.stringify({status:'canceled'})});
   return '';
  }
  if(intent.action==='facility_accept') {
   executingFacility=true;
   intent=await executeFacility(intent.plan,{previousId:prior.id,draftId:draft.id,acceptedAt:new Date().toISOString()},services);
   intent.facilityTurn=true;
  }
  if(!['create','update','cancel'].includes(intent.action)) {
   const reply=typeof intent.reply==='string'?intent.reply:'For staff help, call (541) 652-6065. Nothing has been changed.';
   const savedReply=reply.replace(/#draft=[A-Za-z0-9_-]{40,60}/g,'#draft=[private link]');
   const savedIntent={...intent,reply:savedReply};
   const updated=await rest(`sms_booking_drafts?id=eq.${draft.id}&status=eq.processing`,{method:'PATCH',body:JSON.stringify({status:intent.action==='clarify'?'clarification':'staff',intent:savedIntent,reply_text:savedReply}),headers:{Prefer:'return=representation'}});return updated.length&&await hasConsent(phone)?reply:'';
  }
  const token=crypto.randomBytes(32).toString('base64url');
  const base=(process.env.PUBLIC_SITE_URL || 'https://www.ruthobenchainrc.com').replace(/\/+$/,'');
  const updated=await rest(`sms_booking_drafts?id=eq.${draft.id}&status=eq.processing`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({status:'ready',intent,token_hash:hash(token)})});
  if(!updated.length||!await hasConsent(phone))return '';
  return `I prepared your ${intent.action} request. Review the exact bookings and approve after RORC sign-in: ${base}/sms-booking/#draft=${token} Link expires in 20 minutes. Nothing has changed yet. Reply STOP to opt out.`;
 } catch(error) {
  await rest(`sms_booking_drafts?id=eq.${draft.id}&status=eq.processing`,{method:'PATCH',body:JSON.stringify({status:'staff',reply_text:'AI unavailable; staff review required.'})}).catch(()=>{});
  const policy=await require('./_sms-conversation-settings').conversationAiSnapshot(phone).catch(()=>({allowed:false}));
  return policy.allowed&&String(policy.revision)===String(initialPolicy.revision)&&await hasConsent(phone).catch(()=>false)?(executingFacility?'I could not confirm the result. Please check your visit and heater status in the app.':'I could not safely finish this request. Your text is in the staff inbox for help. Nothing has been changed.') :'';
 }
}
module.exports={rest,hash,handleBookingSms,cancelPhoneDrafts,hasFacilityConversation};
