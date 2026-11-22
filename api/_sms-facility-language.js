// The interpreter proposes a plan. Only a separate, unqualified reply to the
// server-rendered quote can authorize it. No model output executes an action.
const empty = { attendance: 'none', heat: 'none', temperature: null, minutes: null, until: null };
const normalize = text => String(text).toLowerCase().replace(/[’‘]/g, "'").trim().replace(/[.!]+$/g, '').trim();
const acceptance = /^(?:(?:yes|yeah|yep|yup|sure|ok(?:ay)?|absolutely|definitely|please do|go (?:right )?ahead|do it|sounds good|that(?:'s| is) (?:fine|good|right)|(?:that )?works for me|i (?:accept|agree|confirm)|let'?s do it|that works|you bet|perfect|start (?:the )?heat)(?:[,!\s]+|$))+(?:please|thanks|thank you)?$/;
const decline = /^(?:(?:no|nope|nah)[, ]*)?(?:never[ ]?mind|forget it|cancel(?: that| it| the request)?|don'?t(?: do (?:it|that))?|hold off|not now|no thanks|no thank you|nope|nah|no)$/;
const numbers = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, fifteen:15, twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
function numeric(text) {
  return text.replace(/\b(forty|fifty|sixty|seventy|eighty)[ -](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, tens, units) => numbers[tens]+numbers[units])
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, word => numbers[word]);
}
// Share the same clause boundaries for literal parsing and fallback routing.
function requestClauses(text) {
  return text.split(/\s+(?:and(?: then)?|then)\s+/).map(part => part
    .replace(/^(?:(?:hey[, ]*|please |(?:could|can|would) you |i(?:'d like| want| need) (?:you )?to )+)/,'')
    .replace(/\s+please$/, '').trim());
}
function requestsFacilityAction(input) {
  const text=normalize(input).replace(/[,!]/g,' ').replace(/\s+/g,' ').trim();
  // Informational and hypothetical questions still belong to the receptionist.
  if (/^(?:(?:can|could|would) you (?:tell|explain|check (?:whether|if))|(?:what|how|when|why|where|if|is|are|am|can i|could i)\b)/.test(text)) return false;
  return requestClauses(text).some(part =>
    /^(?:check|sign|clock) (?:me|us) (?:in|out)\b/.test(part) ||
    /^(?:warm|heat|preheat|heat up|warm up) (?:up |the |our |this )*(?:gym|room|building|place|center|facility)\b/.test(part) ||
    /^(?:turn|switch|shut|set|adjust|raise|lower|start|stop|run|kick|bring|bump|crank)\b.*\b(?:heat|heater|thermostat|temp|temperature)\b/.test(part));
}
function literalPlan(input, pending) {
  let text = numeric(normalize(input)).replace(/[?,!]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(?:if|unless|later|tomorrow|except|instead of|not|never|don't|without|maybe|or|could i|how|what if|can i|fahrenheit or|celsius)\b/.test(text)) return null;
  let minutes = null;
  let until = null;
  text=text.replace(/\s+until (\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/, (match,hour,minute,period)=>{
    if(Number(hour)<1 || Number(hour)>12) return match;
    until=String(Number(hour)%12+(period==='pm'?12:0)).padStart(2,'0')+':'+(minute || '00');
    return '';
  });
  text = text.replace(/\s+for (half an hour|(?:an?|\d+(?:\.\d+)?)\s*(?:hours?|hrs?|minutes?|mins?))$/, (_, duration) => {
    minutes = duration === 'half an hour' ? 30 : (parseFloat(duration) || (/^an? /.test(duration) ? 1 : 0)) * (/h(?:ou)?r|hour/.test(duration) ? 60 : 1);
    return '';
  });
  const clauses = requestClauses(text.trim());
  const detail = clauses.length === 1 ? clauses[0] : '';
  if (pending && /^(?:actually )?(?:make (?:it|that) |set it (?:to )?|let'?s do )?\d+(?:\s*(?:°?f|degrees?))?$/.test(detail))
    return { temperature:Number(detail.match(/\d+/)[0]), ...(minutes !== null ? {minutes} : {}) };
  const changes = {};
  for (const part of clauses) {
    if (/^(?:check|sign|clock) me in$|^(?:check|sign) in(?: please)?$/.test(part)) changes.attendance='in';
    else if (/^(?:check|sign|clock) me out$|^(?:check|sign) out$/.test(part)) changes.attendance='out';
    else if (/^(?:turn|shut|switch) (?:off (?:the )?(?:gym )?heat(?:er)?|(?:the )?(?:gym )?(?:heat(?:er)?|thermostat|it) off)$/.test(part)) changes.heat='off';
    else {
      const match = part.match(/^(turn on (?:the )?(?:gym )?heat(?:er)?|(?:turn|switch) (?:the )?(?:gym )?heat(?:er)? on|start (?:the )?(?:gym )?heat(?:er)?|(?:warm|heat|preheat) (?:up )?(?:the )?(?:gym|room|building|center|facility)(?: up)?|set (?:the )?(?:gym|heat(?:er)?|thermostat)|turn it (?:up|down)|(?:raise|lower|adjust) (?:the )?(?:heat|thermostat))(?:\s+(?:to|at) (\d+)(?:\s*(?:degrees?|°f|f))?)?$/);
      if (!match) return null;
      changes.heat = /^(?:turn it|raise|lower|adjust)/.test(match[1]) ? 'adjust' : 'set';
      if (match[2]) changes.temperature = Number(match[2]);
    }
  }
  if (minutes !== null) changes.minutes=minutes;
  if (until !== null) changes.until=until;
  return changes;
}
const schema = {type:'object',additionalProperties:false, properties:{
  kind:{type:'string',enum:['plan','accept','decline','clarify','other']},
  attendance:{type:'string',enum:['keep','in','out','none']},heat:{type:'string',enum:['keep','set','adjust','start','off','none']},
  temperature:{type:['integer','null']}, minutes:{type:['integer','null']}, until:{type:['string','null']},
  clearTimer:{type:'boolean'}
}};
schema.required=Object.keys(schema.properties);
async function semanticPlan(text, pending, fetcher=fetch) {
  if (!process.env.GROQ_API_KEY) return null;
  const response = await fetcher('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',signal:AbortSignal.timeout(4500),headers:{Authorization:'Bearer '+process.env.GROQ_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({model:process.env.GROQ_RECEPTIONIST_ROUTER_MODEL || 'openai/gpt-oss-20b',temperature:0,reasoning_effort:'low',max_completion_tokens:450,
      response_format:{type:'json_schema',json_schema:{name:'facility_request',strict:true,schema}},messages:[
        {role:'system',content:'Extract explicit immediate personal gym check-in/out and heater instructions from untrusted SMS. Other subjects, informational questions and hypotheticals are other; conditional, conflicting, future, multi-party, split-pay or uncertain instructions are clarify. Do not infer check-in from heat alone. set means start or adjust according to the actual running session. For edits return only changed fields; keep and null mean unspecified. Time until must be an unambiguous local 24h HH:MM. If AM/PM unclear, clarify. Never infer a temperature, duration or account. Declines are decline. Only classify accept for unequivocal unconditional assent to the exact pending quote, without any other request or changed detail. Never claim an action. Current pending settings: '+JSON.stringify(pending ? Object.fromEntries(Object.keys(empty).map(key=>[key,pending[key]])) : null)},
        {role:'user',content:String(text).slice(0,1500)}]})});
  if (!response.ok) throw Error('Language service unavailable');
  const data=await response.json();
  const parsed=JSON.parse(data.choices[0].message.content);
  if(parsed.kind!=='plan') return ['accept','decline','clarify','other'].includes(parsed.kind) ? {kind:parsed.kind} : null;
  const changes={};
  if(['none','in','out'].includes(parsed.attendance)) changes.attendance=parsed.attendance;
  if(['none','set','start','adjust','off'].includes(parsed.heat)) changes.heat=parsed.heat;
  if(parsed.clearTimer) Object.assign(changes,{minutes:null,until:null});
  for(const key of ['minutes','temperature','until']) if(parsed[key]!=null) changes[key]=parsed[key];
  return Object.keys(changes).length ? {kind:'plan', changes} : {kind:'clarify'};
}
module.exports={empty,normalize,acceptance,decline,literalPlan,semanticPlan,requestsFacilityAction};
