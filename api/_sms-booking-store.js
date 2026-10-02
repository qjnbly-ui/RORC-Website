const crypto=require('node:crypto');
const {normalizePhone,hasConsent}=require('./_rorc-sms');
const {interpretAssistant}=require('./_sms-assistant');
const URL=(process.env.SUPABASE_URL || 'https://aedvuofiodtsgijcxyqx.supabase.co').replace(/\/+$/,'');
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const hash=(token)=>crypto.createHash('sha256').update(String(token)).digest('hex');
async function rest(path,options={}) {
 const response=await fetch(`${URL}/rest/v1/${path}`,{...options,headers:{apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':'application/json',...options.headers}});
 const body=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(body.message || 'SMS booking storage unavailable.'),{status:response.status,code:body.code});return body;
}
async function cancelPhoneDrafts(phone) {const normalized=normalizePhone(phone);if(normalized)await rest(`sms_booking_drafts?phone_e164=eq.${encodeURIComponent(normalized)}&status=in.(processing,ready,clarification)`,{method:'PATCH',body:JSON.stringify({status:'canceled'})});}
async function handleBookingSms(payload,options={}) {
 const phone=normalizePhone(payload.From),sid=String(payload.MessageSid || payload.SmsMessageSid || '');
 if(!phone||!/^SM[a-zA-Z0-9]{32}$/.test(sid))throw new Error('Invalid SMS identity.');
 if(!await hasConsent(phone))return ''; // STOP/START/HELP remain the ingress authority.
 const reserved=await rest('sms_booking_drafts?on_conflict=message_sid',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({message_sid:sid,phone_e164:phone,message_body:String(payload.Body || '').slice(0,1500),status:'processing',expires_at:new Date(Date.now()+20*60*1000).toISOString()})});
 if(!reserved.length)return ''; // Retries cannot send or execute twice.
 const draft=reserved[0];
 try {
  const rows=await rest(`sms_booking_drafts?select=message_body,reply_text,intent&phone_e164=eq.${encodeURIComponent(phone)}&id=neq.${draft.id}&status=in.(clarification,staff,ready)&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&order=created_at.desc&limit=6`);
  const previous=rows[0]?.intent || {};
  const history=rows.reverse().flatMap(row=>[{role:'user',content:row.message_body},{role:'assistant',content:String(row.reply_text || '')}]);
  const intent=await (options.interpret || interpretAssistant)(payload.Body || '',history,{...previous,phone});
  // A newer text supersedes a slow answer; a staff reply pauses AI for 20 minutes.
  // These reads also fail closed when conversation state cannot be verified.
  const latest=await rest(`sms_booking_drafts?select=id&phone_e164=eq.${encodeURIComponent(phone)}&order=created_at.desc&limit=1`);
  const manual=await rest(`staff_communication_messages?select=id&to_e164=eq.${encodeURIComponent(phone)}&direction=eq.outbound&message_at=gt.${encodeURIComponent(new Date(Date.now()-20*60*1000).toISOString())}&limit=1`);
  if((latest[0]&&latest[0].id!==draft.id)||manual.length){
   await rest(`sms_booking_drafts?id=eq.${draft.id}&status=eq.processing`,{method:'PATCH',body:JSON.stringify({status:'canceled'})});
   return '';
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
  return await hasConsent(phone).catch(()=>false)?'I could not safely finish this request. Your text is in the staff inbox for help. Nothing has been changed.':'';
 }
}
module.exports={rest,hash,handleBookingSms,cancelPhoneDrafts};
