(function(){
 const token=new URLSearchParams(location.hash.slice(1)).get('draft') || '';
 let ready=false;
 const byId=id=>document.getElementById(id);
 async function request(action){
  const client=await window.RORC_SUPABASE.getClient();
  const {data}=await client.auth.getSession();
  if(!data.session?.access_token)throw new Error('Sign in to RORC, then return here and refresh the preview.');
  const response=await fetch('/api/sms-booking-draft',{method:'POST',headers:{Authorization:`Bearer ${data.session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({token,action})});
  const body=await response.json();if(!response.ok||!body.success)throw new Error(body.error||'The booking change could not be processed.');return body;
 }
 async function preview(){
  ready=false;byId('smsBookingConfirm').disabled=true;
  try{
   const result=await request('preview');
   if(result.confirmed){byId('smsBookingHelp').textContent='This request was already approved. For further changes, send a new text or contact RORC.';byId('smsBookingStatus').textContent=result.result?.pendingReview?'Your request is pending manager approval.':'Your booking change was applied.';return;}
   const actions={create:'Create bookings',update:'Update bookings',cancel:'Cancel bookings',request_update:'Request booking updates',request_cancel:'Request booking cancellations'};
   const scopes={this:'This occurrence',following:'This and following occurrences',all:'Entire series'};
   byId('smsBookingStatus').textContent=`${actions[result.action] || 'Booking request'}${result.action==='create'?'':` · ${scopes[result.scope] || result.scope}`} · ${result.preview.length} occurrence(s)`;
   byId('smsBookingNotice').textContent=result.notice;
   const table=document.createElement('table');table.style.width='100%';table.style.minWidth='620px';const head=table.createTHead().insertRow();
   ['Booking','Date','Access','Event','Estimated rental cost','Payment state'].forEach(label=>{const cell=document.createElement('th');cell.textContent=label;head.appendChild(cell);});
   const body=table.createTBody();result.preview.forEach(item=>{const row=body.insertRow();[item.bookingNumber,item.date,`${item.start}–${item.end}`,`${item.title}${item.contactName?' · '+item.contactName:''}${item.contactEmail?' · '+item.contactEmail:''}`,Number.isFinite(item.estimatedCents)?`$${(item.estimatedCents/100).toFixed(2)}`:'Staff review',item.paymentStatus].forEach(value=>{const cell=row.insertCell();cell.textContent=value;});});
   byId('smsBookingPreview').replaceChildren(table);byId('smsBookingScrollHint').hidden=false;ready=true;byId('smsBookingConfirm').disabled=false;
  }catch(error){byId('smsBookingStatus').textContent=error.message;}
 }
 async function confirm(){
  if(!ready)return;ready=false;byId('smsBookingConfirm').disabled=true;
  try{const result=await request('confirm');byId('smsBookingHelp').textContent='Your approval was recorded. For further changes, send a new text or contact RORC.';byId('smsBookingStatus').textContent=result.result?.pendingReview?'Your change request is pending RORC manager approval.':'Your booking change was applied successfully. No payment was charged.';}
  catch(error){byId('smsBookingStatus').textContent=error.message;}
 }
 document.addEventListener('DOMContentLoaded',()=>{byId('smsBookingRefresh').addEventListener('click',preview);byId('smsBookingConfirm').addEventListener('click',confirm);preview();});
})();
