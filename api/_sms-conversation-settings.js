const {rest}=require('./_sms-booking-store');
const {normalizePhone}=require('./_rorc-sms');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const error=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
function aiSettings(row) {
 return {aiMode:row.ai_mode,aiResumeAfterMinutes:Number(row.ai_resume_after_minutes),aiPausedUntil:row.ai_paused_until||null};
}
async function conversationAiSnapshot(phone) {
 const normalized=normalizePhone(phone);if(!normalized)return {allowed:false,revision:null};
 const rows=await rest(`staff_communication_threads?select=ai_mode,ai_paused_until,ai_revision&phone_e164=eq.${encodeURIComponent(normalized)}&limit=1`);
 const row=rows[0];
 return {revision:row?.ai_revision??null,allowed:Boolean(row&&Number.isSafeInteger(Number(row.ai_revision))&&row.ai_revision!=null&&row.ai_mode==='automatic'&&(!row.ai_paused_until||(Number.isFinite(Date.parse(row.ai_paused_until))&&Date.parse(row.ai_paused_until)<=Date.now())))};
}
async function conversationAiAllowed(phone) {return (await conversationAiSnapshot(phone)).allowed;}
async function updateConversationAi({threadId,mode,resumeAfterMinutes,resumeNow=false}) {
 if(!UUID.test(String(threadId||'')))throw error('A valid conversation is required.');
 if(!['automatic','never'].includes(mode))throw error('Choose when AI may reply.');
 if(!Number.isInteger(resumeAfterMinutes)||resumeAfterMinutes<5||resumeAfterMinutes>10080)throw error('Choose a resume period from 5 minutes to 7 days.');
 if(typeof resumeNow!=='boolean')throw error('Resume now must be true or false.');
 const row=await rest('rpc/set_sms_conversation_ai',{method:'POST',body:JSON.stringify({thread_id:threadId,mode,resume_minutes:resumeAfterMinutes,resume_now:resumeNow})});
 return aiSettings(row);
}
module.exports={aiSettings,conversationAiSnapshot,conversationAiAllowed,updateConversationAi};
