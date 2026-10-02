// SMS uses the same public knowledge and live answers as the voice receptionist.
// Only the existing authenticated booking workflow may propose database changes.
const {answer,smsMessageFor}=require('../.build/receptionist/public-assistant');
const {classifyIntent,fallbackIntent}=require('../.build/receptionist/router');
const {normalizeFormAnswer}=require('../.build/receptionist/form-input');
const {getFormDefinition,detectFormRequest}=require('./_rorc-forms');
const {createFormDraft}=require('./_rorc-form-drafts');
const {interpretSms}=require('./_sms-booking-ai');
const conversational=(reply,state={})=>({action:'clarify',reply,assistantState:state});
function bookingDirective(text) {
 return /^(?:(?:please|can you|could you|would you)\s+)?(?:book|reserve|schedule|change|move|reschedule|cancel|update)\b/i.test(text)
  || /\b(?:i|we) (?:want|need|would like) to (?:book|reserve|schedule|change|move|reschedule|cancel|update)\b/i.test(text);
}
function privateRequest(text) {
 return /\b(?:my|our)\b.{0,50}\b(?:account|balance|billing|dues|membership status|access code|pin|payments)\b|\b(?:password|heater pin|door code)\b/i.test(text);
}
function prompt(field) {
 if(field.callerPhoneAllowed)return 'What phone number should I prefill? Reply USE THIS NUMBER to use your texting number, or enter a different number.';
 if(['yesno','yesno-title'].includes(field.type))return `${field.prompt} Reply YES IT WILL or NO IT WILL NOT.`;
 if(field.type==='date')return 'What event date should I prefill? Please use YYYY-MM-DD, including the year.';
 if(field.type==='time')return `${field.prompt} Please use HH:mm (24-hour time) or include AM/PM.`;
 return field.prompt;
}
async function formReply(session,text,phone,options) {
 const form=getFormDefinition(session.formId);
 if(!form||!Number.isInteger(session.fieldIndex)||session.fieldIndex<0||session.fieldIndex>=form.fields.length)return conversational('Please tell me which form you need help with.');
 const finish=async()=>{
  const draft=await (options.createFormDraft||createFormDraft)(form.id,session.answers,phone);
  return conversational(`I prepared your ${form.title}: ${draft.url} Review and finish online. I have not submitted an application, reserved space, or charged anything.`);
 };
 if(/^finish online[.!]?$/i.test(text.trim()))return finish();
 const field=form.fields[session.fieldIndex];
 if(field.type==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(text.trim()))return conversational(prompt(field),{formSession:session});
 if(field.type==='time'&&!/^(?:([01]\d|2[0-3]):[0-5]\d|\d{1,2}(?::[0-5]\d)?\s*[ap]\.?m\.?)$/i.test(text.trim()))return conversational(prompt(field),{formSession:session});
 const booleanField=['yesno','yesno-title'].includes(field.type);
 const negative=/^(?:no|no it will not|no it won't)[.!]?$/i.test(text.trim());
 const positive=/^(?:yes|yes it will)[.!]?$/i.test(text.trim());
 const parsed=booleanField?(negative||positive?{skipped:false,value:field.type==='yesno-title'?(positive?'Yes':'No'):(positive?'yes':'no')}:null):await normalizeFormAnswer(field,field.callerPhoneAllowed&&/^use this number[.!]?$/i.test(text.trim())?'yes':text,phone);
 if(!parsed)return conversational(`I could not confirm that answer. ${prompt(field)}`,{formSession:session});
 // Dates must round-trip exactly; no year inference or calendar correction.
 if(field.type==='date'&&(parsed.value!==text.trim()||new Date(`${text.trim()}T12:00:00Z`).toISOString().slice(0,10)!==text.trim()))return conversational(prompt(field),{formSession:session});
 const next={formId:form.id,fieldIndex:session.fieldIndex+1,answers:{...session.answers,...(parsed.skipped?{}:{[field.key]:parsed.value})}};
 if(next.fieldIndex===form.fields.length){session=next;return finish();}
 return conversational(`${prompt(form.fields[next.fieldIndex])} You can reply FINISH ONLINE at any time.`,{formSession:next});
}
async function interpretAssistant(text,history=[],context={},options={}) {
 text=String(text||'').trim().slice(0,1500);
 history=history.filter(item=>['user','assistant'].includes(item.role)).slice(-10);
 let state=context.assistantState||{};
 if(/\b(?:talk|speak|connect)\b.{0,40}\b(?:staff|human|person|quentin)\b|^staff please[.!]?$/i.test(text))return {action:'staff',reply:'For staff help, call (541) 652-6065. Nothing has been changed.',assistantState:{handoff:true}};
 if(state.handoff&&!/\b(?:ai|assistant)\b/i.test(text))return {action:'staff',reply:'',assistantState:state};
 if(state.handoff)state={};
 if(privateRequest(text))return conversational('For private account information, sign in to your RORC member dashboard: https://www.ruthobenchainrc.com/member-dashboard/ A texting number or shared PIN does not verify your account.',state);
 if(/^(?:hi|hello|hey|what can you do|help me)[!?.]*$/i.test(text))return conversational('I’m the RORC AI text assistant. I can answer questions about memberships, rentals, events and the facility, share links, help fill out applications, and prepare booking changes for your signed-in approval. What would you like help with?',state);
 const isQuestion=/^(?:how|what|when|where|why|is|are|do|does|can i|could i)\b/i.test(text);
 if(/^cancel (?:the )?form[.!]?$/i.test(text))return conversational('Form preparation canceled. Nothing has been submitted.');
 if(state.formSession&&!isQuestion)return formReply(state.formSession,text,context.phone,options);
 const formId=detectFormRequest(text);
 if(formId&&formId!=='rental'&&!isQuestion){const form=getFormDefinition(formId);return conversational(`I can help prepare your ${form.title}. ${prompt(form.fields[0])} Reply FINISH ONLINE at any time.`,{formSession:{formId,fieldIndex:0,answers:{}}});}
 if(formId==='rental'&&/\b(?:form|application|fill)\b/i.test(text)&&!isQuestion){const form=getFormDefinition(formId);return conversational(`I can help prepare your ${form.title}. ${prompt(form.fields[0])} Reply FINISH ONLINE at any time.`,{formSession:{formId,fieldIndex:0,answers:{}}});}
 if(bookingDirective(text)||(state.booking&&!isQuestion)||(!isQuestion&&/\b(?:every|tue(?:sday)?|thu(?:rsday)?)\b/i.test(text)&&/\b(?:through|until|excluding|except|weekly)\b/i.test(text))){
  const intent=await (options.interpretBooking||interpretSms)(text,history);
  return {...intent,assistantState:{booking:intent.action==='clarify'}};
 }
 if(/\b(?:send|share|text)\b.{0,50}\b(?:link|website|page|directions)\b/i.test(text))return conversational(smsMessageFor(text,history).body,state);
 let route;
 try {route=await (options.classify||classifyIntent)(text,history,{timeoutMs:3000});}catch {route=fallbackIntent(text);}
 if(route.intent==='check_account')return conversational('Sign in for private account help: https://www.ruthobenchainrc.com/member-dashboard/ For staff assistance, call (541) 652-6065.',state);
 if(route.intent==='request_person')return {action:'staff',reply:'For staff help, call (541) 652-6065. Nothing has been changed.',assistantState:{handoff:true}};
 // Router suggestions are advisory: model output cannot initiate a form or mutation.
 const reply=await (options.answer||answer)(text,history,route.detail_level,route,{channel:'sms'});
 return conversational(String(reply).slice(0,1200),state);
}
module.exports={interpretAssistant,bookingDirective,privateRequest,prompt};
