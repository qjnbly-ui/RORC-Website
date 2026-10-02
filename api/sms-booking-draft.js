const { accountMemberFilter } = require("./_account-scope");
const { getSmsBookingSettings } = require('./_sms-booking-settings');
const {rest,hash}=require('./_sms-booking-store');
const {normalizePhone,hasConsent}=require('./_rorc-sms');
const {createCommand,validateIntent}=require('./_sms-booking-ai');
const {calculateRentalTotalCents}=require('./rental-reviews');
const {commandFromBody}=require('./recurring-rentals');
const URL=(process.env.SUPABASE_URL || 'https://aedvuofiodtsgijcxyqx.supabase.co').replace(/\/+$/,'');
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).json({success:false,error:'Method not allowed.'});
 if(!KEY)return res.status(503).json({success:false,error:'Booking service unavailable.'});
 try{
  const token=String(req.headers?.authorization || '').match(/^Bearer (.+)$/i)?.[1];
  if(!token)throw fail('Sign in to review and approve this booking change.',401);
  const response=await fetch(`${URL}/auth/v1/user`,{headers:{apikey:KEY,Authorization:`Bearer ${token}`}});
  if(!response.ok)throw fail('Sign in again to approve this change.',401);
  const user=await response.json();
  const members=await rest(`account_members?select=id,account_id,account_type,member_name,email_address,phone_number&${await accountMemberFilter(user.id,req,rest)}&limit=1`);
  const member=members[0];if(!member)throw fail('Member account required.',403);
  const draftToken=String(req.body?.token || '');if(!/^[A-Za-z0-9_-]{43}$/.test(draftToken))throw fail('Invalid booking link.');
  const rows=await rest(`sms_booking_drafts?select=*&token_hash=eq.${hash(draftToken)}&limit=1`);
  const draft=rows[0];if(!draft||normalizePhone(member.phone_number)!==draft.phone_e164||(draft.verified_member_id&&draft.verified_member_id!==member.id))throw fail('This link does not belong to your signed-in account. Contact staff if your phone number has changed.',403);
  if(!await hasConsent(draft.phone_e164))throw fail('Texts are opted out. Nothing can be changed from this link.',403);
  if(draft.status==='confirmed')return res.status(200).json({success:true,confirmed:true,result:draft.result});
  if(!(await getSmsBookingSettings()).enabled)throw fail('AI booking assistance is paused. Contact RORC staff for help. Nothing has been changed.',409);
  if(draft.status!=='ready'||new Date(draft.expires_at).getTime()<=Date.now())throw fail('This booking link expired or was canceled. Text a new request.',409);
  if(req.body.action==='confirm'){
   if(!draft.resolved_command||draft.verified_member_id!==member.id)throw fail('Review the exact booking preview before confirming.',409);
   const result=await rest('rpc/confirm_sms_booking_draft',{method:'POST',body:JSON.stringify({actor_id:member.id,draft_token_hash:hash(draftToken)})});
   return res.status(200).json({success:true,confirmed:true,result});
  }
  if(req.body.action!=='preview')throw fail('Choose preview or confirm.');
  let command=draft.resolved_command;
  if(!command){
   const intent=validateIntent(draft.intent);
   if(!['create','update','cancel'].includes(intent.action))throw fail(intent.reply||'This request needs clarification.',409);
   if(intent.action==='create')command=createCommand(intent,member);
   else{
    const matches=await rest(`rental_requests?select=*&booking_number=eq.${encodeURIComponent(intent.bookingNumber)}&limit=2`);
    const rental=matches[0];
    if(matches.length!==1||!rental||(member.account_type!=='Account Manager'&&rental.claimed_member_id!==member.id&&(rental.claimed_member_id||!member.email_address||String(rental.contact_email).toLowerCase()!==member.email_address.toLowerCase())))throw fail('Booking not found in your account. Staff can help resolve the booking number.',404);
    const patch={};
    if(intent.action==='update'){
     if(intent.title)patch.event_name=intent.title;
     if(intent.startTime||intent.endTime){patch.event_start_time=intent.startTime;patch.event_end_time=intent.endTime;}
     if(intent.startDate){if(intent.scope!=='this')throw fail('Date changes apply to a single occurrence. Send a separate series time/title request.',409);patch.event_date=intent.startDate;}
     if(!Object.keys(patch).length)throw fail('Specify the booking fields you want to change.',409);
    }
    command=commandFromBody({action:member.account_type==='Account Manager'?intent.action:`request_${intent.action}`,scope:intent.scope,rentalRequestId:rental.id,patch},member.account_type==='Account Manager');
   }

  }
  const rentals=command.rentals || await rest(`rental_requests?select=*&id=eq.${command.rentalRequestId}&limit=1`);
  const target=rentals[0];
  let selected=rentals;
  if(!command.rentals&&command.scope!=='this'&&target?.recurring_series_id){
   selected=await rest(`rental_requests?select=*&recurring_series_id=eq.${encodeURIComponent(target.recurring_series_id)}${command.scope==='following'?`&event_date=gte.${target.event_date}`:''}&order=event_date.asc&limit=241`);
   if(selected.length>240)throw fail('Series is too large for one approval.',409);
  }
  if(!selected.length)throw fail('Booking no longer exists. Send a fresh request.',409);
  if(!command.rentals&&member.account_type!=='Account Manager'&&selected.some(row=>row.claimed_member_id!==member.id&&(!member.email_address||String(row.contact_email).toLowerCase()!==member.email_address.toLowerCase())))throw fail('This series includes bookings outside your account. Staff can help.',403);
  if(command.action==='create'||command.action.includes('update'))await rest('rpc/preview_rental_access',{method:'POST',body:JSON.stringify({proposals:selected.map(row=>({...row,...command.patch})),excluded_ids:command.rentals?[]:selected.map(row=>row.id)})});
  if(!draft.resolved_command){
   if(!command.rentals){command.expectedIds=selected.map(row=>row.id);command.expectedVersions=Object.fromEntries(selected.map(row=>[row.id,row.updated_at]));}
   const bound=await rest(`sms_booking_drafts?id=eq.${draft.id}&verified_member_id=is.null&status=eq.ready`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({verified_member_id:member.id,resolved_command:command})});
   if(!bound.length)throw fail('Draft changed while being prepared. Refresh the preview.',409);
  } else if(command.expectedVersions&&(selected.length!==command.expectedIds.length||selected.some(row=>command.expectedVersions[row.id]!==row.updated_at)))throw fail('A booking changed since this draft was prepared. Send a fresh request before approving.',409);
  const preview=selected.map(row=>({bookingNumber:row.booking_number || 'New booking',date:command.patch?.event_date || row.event_date,start:command.patch?.event_start_time || row.event_start_time,end:command.patch?.event_end_time || row.event_end_time,title:command.patch?.event_name || row.event_name,paymentStatus:row.payment_status || 'unbilled',contactName:row.contact_name,contactEmail:row.contact_email,estimatedCents:command.action.includes('update')?calculateRentalTotalCents({...row,...command.patch}):row.estimated_total_cents}));
  return res.status(200).json({success:true,action:command.action,scope:command.scope,preview,expiresAt:draft.expires_at,notice:'Times are America/Los_Angeles. Availability is rechecked on approval. No payment is charged. Renter changes remain pending manager approval.'});
 }catch(error){return res.status(error.code==='23P01'||error.code==='55000'?409:error.code==='42501'?403:Number(error.status)||500).json({success:false,error:error.message||'Could not process the booking draft.'});}
};
