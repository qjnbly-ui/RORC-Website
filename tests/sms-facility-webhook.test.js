const test=require('node:test');
const assert=require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-key';
process.env.TWILIO_AUTH_TOKEN='fixture-twilio';
process.env.ECOBEE_HEATER_THERMOSTAT_ID='fixture-heat';
const twilio=require('twilio');
const sms=require('../api/receptionist/sms');
const {publicHttpUrl}=require('../api/_receptionist');

test('signed Twilio thread selects an account, accepts plain yes, ignores redelivery, and honors opt-out and staff takeover',async(t)=>{
  const phone='+15415550101',rows=[];
  let opted=true,enabled=true,mode='automatic',revision=0,accepted=0,stored=0,count=0;
  const rowA={member_id:'a',label:'Member · Active Membership · #12'};
  const rowB={member_id:'b',label:'Member · Special Access Account · #24'};
  t.mock.method(global,'fetch',async(input,options={})=>{
    const url=new URL(input),path=url.pathname.split('/').pop(),query=url.searchParams;
    const b=options.body && JSON.parse(options.body);
    const reply=obj=>Response.json(obj);
    if(path==='record_staff_communication_message'){stored++;return reply({});}
    if(path==='automation_settings') return reply([{config:{enabled}}]);
    if(path==='staff_communication_threads') return reply([{ai_mode:mode,ai_revision:revision}]);
    if(path==='rorc_receptionist_sms_consent') {
      if(b) opted=b.consent_status==='opt_in';
      return reply([{consent_status:opted?'opt_in':'opt_out'}]);
    }
    if(path==='sms_facility_members') {assert.equal(b.sender,phone);return reply([rowA,rowB]);}
    if(path==='sms_facility_preview'){
      assert.equal(b.actor,'b'); return reply({canHeat:true,canEnter:true,enabled:true,account:'account-b',runtime:null,monthly:3456,owed:456,month:'2026-11'});
    }
    if(path==='thermostatSummary') return reply({status:{code:0},revisionList:['fixture-heat:Gym:false:1:1:1:1'],statusList:['fixture-heat:']});
    if(path==='accept_sms_facility_action'){
      const quote=rows.find(r=>r.id===b.quote_id),plan=quote.intent.assistantState.facility;
      assert.equal(plan.member,'b');assert.equal(plan.temperature,68);assert.equal(plan.monthly,3456);
      assert.equal(quote.status,'clarification');assert.equal(b.equipment_ready,false);
      accepted++;quote.status='confirmed';
      return reply({attendance:'You are checked in.',problem:'The thermostat is offline.'});
    }
    if(path!=='sms_booking_drafts') throw Error('Unexpected HTTP request '+path);
    if(options.method==='POST'){
      if(rows.some(row=>row.message_sid===b.message_sid))return reply([]);
      const row={...b,id:'draft-'+rows.length};rows.unshift(row);return reply([row]);
    }
    if(options.method==='PATCH'){
      if(!query.has('id')){for(const r of rows) if(['processing','ready','clarification'].includes(r.status)) r.status='canceled';return reply([]);}
      const row=rows.find(r=>query.get('id')==='eq.'+r.id);
      Object.assign(row,b);return reply([row]);
    }
    if(query.has('message_sid'))return reply(rows.filter(r=>query.get('message_sid')==='eq.'+r.message_sid));
    if(query.get('id')?.startsWith('neq.'))return reply(rows.filter(r=>query.get('id')!=='neq.'+r.id).slice(0,6));
    return reply(rows.slice(0,1));
  });
  async function inbound(Body,id,valid=true) {
    const body={From:phone,To:'+15416526065',MessageSid:'SM'+String(id??++count).padStart(32,'0'),Body};
    const req={method:'POST',url:'/api/receptionist/sms',headers:{host:'example.test','x-forwarded-proto':'https'},body};
    req.headers['x-twilio-signature']=valid?twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN,publicHttpUrl(req),body):'invalid';
    const res={setHeader(){},status(code){this.code=code;return this;},send(xml){this.xml=xml;return this;}};
    await sms(req,res);return res;
  }
  assert.equal((await inbound('sign me in',900,false)).code,403);assert.equal(stored,0);
  assert.match((await inbound('Sign me in and warm the gym to 68 for an hour.')).xml,/Which account/);
  const quoted=await inbound('the second one');assert.match(quoted.xml,/check you in and start the heater at 68°F for 60 minutes/);assert.match(quoted.xml,/\$34\.56 charged, \$4\.56 outstanding/);
  const yes=await inbound('yes',777);assert.match(yes.xml,/checked in.*offline/);assert.equal(accepted,1);
  await inbound('yes',777);assert.equal(accepted,1);
  const another=await inbound('set the heat to 70');assert.match(another.xml,/Which account/);
  await inbound('second');mode='never';revision++;await inbound('sure');assert.equal(accepted,1);
  mode='automatic';revision++;await inbound('STOP');assert.equal(opted,false);
  await inbound('go ahead');assert.equal(accepted,1);
  await inbound('yes',777);assert.equal(opted,false);
  assert.match((await inbound('START')).xml,/texts are now enabled/);
  enabled=false;await inbound('sign me in');assert.equal(accepted,1);
});
