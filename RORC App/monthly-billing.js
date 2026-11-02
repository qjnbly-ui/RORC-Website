(() => {
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
  const time=value=>value?new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'}).format(new Date(value)):'';
  const pending=item=>item.deliveryPending||item.invoiceStatus==='draft';
  const deliveryItems=account=>account.items.filter(item=>item.status==='ready'||pending(item));
  const total=items=>items.reduce((sum,item)=>sum+item.amountCents,0);
  const needsReview=account=>(account.heaterMatches||[]).filter(m=>m.needsReview);
  const blocked=account=>account.unbilledRentals.length||needsReview(account).length||account.issues.length;
  const canSend=account=>!blocked(account)&&total(deliveryItems(account))>0;
  function previousMonth(){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit'}).formatToParts(new Date());
    return new Date(Date.UTC(Number(parts.find(p=>p.type==='year').value),Number(parts.find(p=>p.type==='month').value)-2,1)).toISOString().slice(0,7);
  }
  let savedMonth='';
  window.RORC_MONTHLY_BILLING={mount};
  async function mount({root,token,confirm,openPayments,openRentals,isActive=()=>true,readOnly=false}){
    let month=savedMonth||previousMonth(),preview=null,busy=false,selected=new Set(),message='',initialized=false,loadId=0;
    const mountId=`${Date.now()}-${Math.random()}`;
    root.dataset.billingMount=mountId;
    const alive=()=>root.isConnected&&isActive()&&root.dataset.billingMount===mountId;
    async function request(body){
      const response=await fetch(body?'/api/monthly-billing':`/api/monthly-billing?month=${encodeURIComponent(month)}`,{
        method:body?'POST':'GET',cache:'no-store',headers:{Authorization:`Bearer ${token()}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})
      });
      const result=await response.json();
      if(!response.ok||result.success===false)throw new Error(result.error||'Could not load monthly billing.');
      return result;
    }
    async function load(){
      const id=++loadId;busy=true;render();
      try{
        const next=await request();if(id!==loadId||!alive())return;preview=next;
        if(!initialized){selected=new Set(preview.accounts.filter(a=>/^(APCA|KBYD)$/i.test(a.name)).map(a=>a.accountId));initialized=true;}
      }catch(error){if(id===loadId){preview=null;message=error.message;}}
      finally{if(id===loadId&&alive()){busy=false;render();}}
    }
    function invoiceLink(item){return /^https:\/\/invoice\.stripe\.com\//.test(item.invoiceUrl||'')?`<a href="${escape(item.invoiceUrl)}" target="_blank" rel="noopener">Open invoice</a>`:'';}
    function renderEvent(event){
      return `<details class="monthly-event"><summary><span><strong>${escape(event.name)}</strong><small>${escape(event.date)}${event.attachments.length?` · ${event.attachments.length} attached item${event.attachments.length===1?'':'s'}`:''}</small></span><span class="monthly-event-amount"><strong>${event.needsRentalBill?'Rental bill pending':money(event.totalCents)}</strong><small>View charges</small></span></summary><div class="monthly-event-body">
        ${event.hasRentalBill?`<div class="monthly-event-charge"><span>Rental charge</span><strong>${money(event.rentalCents)}</strong></div>`:event.needsRentalBill?'<p>The rental bill has not been created yet.</p>':''}
        ${event.attachments.length?`<section class="monthly-event-attached"><h4>Attached items</h4><ul>${event.attachments.map(item=>`<li><span><strong>${escape(item.label)}</strong>${item.start?`<small>${escape(time(item.start))}–${escape(time(item.end))}</small>`:''}${item.includedInRental?'<small>Included in rental charge</small>':''}</span>${item.includedInRental?'':`<b>${money(item.amountCents)}</b>`}</li>`).join('')}</ul></section>`:''}
        <div class="monthly-event-charge monthly-event-subtotal"><span>${event.needsRentalBill?'Recorded charges':'Event subtotal'}</span><strong>${money(event.totalCents)}</strong></div><button class="app-admin-btn" data-open-rental="${escape(event.id)}" ${busy?'disabled':''}>View in Rentals</button></div></details>`;
    }
    function renderAccount(account){
      const reviews=needsReview(account);
      const linked=new Set((account.events||[]).flatMap(e=>e.attachments.filter(i=>!i.includedInRental).map(i=>i.id)));
      const other=account.items.filter(i=>!i.rentalId&&(!i.heaterId||!linked.has(i.heaterId)));
      const target=account.unbilledRentals[0]?.id||reviews[0]?.rental?.id||reviews[0]?.candidates[0]?.id||'';
      return `<section class="monthly-billing-account"><header><label><input type="checkbox" data-monthly-select="${escape(account.accountId)}" ${selected.has(account.accountId)?'checked':''} ${busy?'disabled':''}><strong>${escape(account.name)}</strong></label><strong>${money(total(account.items))} recorded this month</strong></header>
        <p>${escape(account.email||'Billing email missing')} · ${account.items.filter(i=>i.status==='invoiced').length} charges invoiced · ${account.items.filter(i=>i.status==='paid').length} paid</p>
        ${account.issues.length?`<ul class="billing-reconciliation-alert">${account.issues.map(i=>`<li>${escape(i)}</li>`).join('')}</ul>`:''}
        ${account.unbilledRentals.length||reviews.length?`<div class="billing-reconciliation-alert"><p>${account.unbilledRentals.length?`${account.unbilledRentals.length} rental bill${account.unbilledRentals.length===1?'':'s'} to finish in Rentals. `:''}${reviews.length?`${reviews.length} heater session${reviews.length===1?'':'s'} to review in Rentals.`:''}</p><button class="app-admin-btn" data-open-rental="${escape(target)}" ${busy?'disabled':''}>Finish in Rentals</button></div>`:''}
        <div class="monthly-events">${(account.events||[]).map(renderEvent).join('')}</div>
        ${other.length?`<details class="monthly-heater-review"><summary>Other saved monthly charges (${other.length})</summary><ul class="record-list">${other.map(i=>`<li><span><strong>${escape(i.reason)}</strong><small>${escape(i.date)}</small></span><b>${money(i.amountCents)}</b></li>`).join('')}</ul></details>`:''}
        ${account.items.length?`<details><summary>All ${account.items.length} saved charge details</summary><div class="monthly-billing-table-wrap"><table class="monthly-billing-table"><thead><tr><th>Date</th><th>Charge</th><th>Status</th><th>Amount</th></tr></thead><tbody>${account.items.map(i=>`<tr><td>${escape(i.date)}</td><td><strong>${escape(i.reason)}</strong><small>${escape(i.source)}${i.eventLabel?` · ${escape(i.eventLabel)}`:''}</small>${invoiceLink(i)}</td><td>${escape(pending(i)?'Awaiting invoice delivery':({ready:'Ready to invoice',invoiced:'Already invoiced',paid:'Paid'})[i.status])}</td><td>${money(i.amountCents)}</td></tr>`).join('')}</tbody></table></div></details>`:''}</section>`;
    }
    function render(){
      if(!alive())return;
      const chosen=(preview?.accounts||[]).filter(a=>selected.has(a.accountId));
      root.innerHTML=`<section class="monthly-billing-page"><header class="account-page-heading"><div><p class="eyebrow">Billing</p><h2>Monthly invoices</h2><p>One monthly invoice per account, with saved charges grouped by event.</p></div></header>
        <div class="monthly-billing-toolbar"><label class="monthly-billing-month"><span>Service month</span><input type="month" id="monthlyServiceMonth" value="${escape(month)}" max="${previousMonth()}" ${busy?'disabled':''}></label><button class="app-admin-btn" data-monthly-refresh ${busy?'disabled':''}>Refresh charges</button><button class="app-admin-btn" data-open-rental="" ${busy?'disabled':''}>Open Rentals</button><button class="app-admin-btn" data-monthly-payments ${busy?'disabled':''}>Payments & invoices</button></div>
        <p class="monthly-billing-note">Finish event bills and attachments in Rentals. Billing displays those saved results for monthly review and sending.</p><p role="status" aria-live="polite" class="monthly-billing-status">${escape(busy?message||'Loading saved charges…':message)}</p>
        ${preview?`<div class="monthly-billing-batch"><strong>${chosen.length} selected · ${money(chosen.reduce((n,a)=>n+total(deliveryItems(a)),0))} selected for invoicing</strong><button class="app-admin-btn app-admin-btn-primary" data-monthly-send ${busy||readOnly||!chosen.some(canSend)||chosen.some(blocked)?'disabled':''}>Review & send selected invoices</button></div>
          ${preview.issues.length?`<div class="billing-reconciliation-alert"><strong>Needs review</strong><ul>${preview.issues.map(i=>`<li>${escape(i)}</li>`).join('')}</ul></div>`:''}
          <div class="monthly-billing-list">${preview.accounts.map(renderAccount).join('')||'<p>No saved charges or unfinished rentals were found for this month.</p>'}</div>`:''}</section>`;
      root.querySelector('#monthlyServiceMonth')?.addEventListener('change',event=>{if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)){event.target.value=month;return;}month=event.target.value;savedMonth=month;preview=null;message='';initialized=false;selected.clear();load();});
      root.querySelector('[data-monthly-refresh]')?.addEventListener('click',()=>{message='';load();});
      root.querySelector('[data-monthly-payments]')?.addEventListener('click',()=>openPayments(month));
      root.querySelectorAll('[data-open-rental]').forEach(button=>button.addEventListener('click',()=>openRentals(button.dataset.openRental||null)));
      root.querySelectorAll('[data-monthly-select]').forEach(input=>input.addEventListener('change',()=>{input.checked?selected.add(input.dataset.monthlySelect):selected.delete(input.dataset.monthlySelect);render();}));
      root.querySelector('[data-monthly-send]')?.addEventListener('click',send);
    }
    function invoiceReview(account){
      const items=deliveryItems(account),used=new Set();
      const events=(account.events||[]).map(event=>{
        const ids=new Set(event.attachments.map(a=>a.id));
        const lines=items.filter(i=>i.rentalId===event.id||ids.has(i.heaterId));lines.forEach(i=>used.add(i.id));
        return lines.length?`<section class="monthly-invoice-event"><h4>${escape(event.name)} · ${escape(event.date)}</h4><ul>${lines.map(i=>`<li>${escape(i.reason)} · ${money(i.amountCents)}</li>`).join('')}</ul><strong>Event subtotal ${money(total(lines))}</strong></section>`:'';
      }).join('');
      const other=items.filter(i=>!used.has(i.id));
      return events+(other.length?`<section class="monthly-invoice-event"><h4>Other monthly charges</h4><ul>${other.map(i=>`<li>${escape(i.date)} · ${escape(i.reason)} · ${money(i.amountCents)}</li>`).join('')}</ul></section>`:'');
    }
    async function send(){
      if(busy||readOnly||!preview)return;
      const chosen=preview.accounts.filter(a=>selected.has(a.accountId));
      if(chosen.some(blocked)){message='Finish the selected accounts in Rentals, then refresh Billing.';render();return;}
      const accounts=chosen.filter(canSend);if(!accounts.length)return;
      const confirmed=await confirm({title:`Send ${month} invoices?`,message:'Review each event and its attached charges. Existing invoices will not be duplicated.',detailHtml:`<ul class="monthly-billing-confirm">${accounts.map(a=>`<li><strong>${escape(a.name)} · ${money(total(deliveryItems(a)))}</strong><span>${escape(a.email)}</span>${invoiceReview(a)}</li>`).join('')}</ul>`,confirmLabel:'Send invoices',cancelLabel:'Keep reviewing'});
      if(!confirmed||!alive())return;
      busy=true;const results=[];
      try{for(const account of accounts){message=`Sending ${account.name}…`;render();try{await request({action:'send',month,accountId:account.accountId,fingerprint:account.fingerprint});results.push(`${account.name}: invoice ready in Stripe.`);}catch(error){results.push(`${account.name}: ${error.message}`);}}}
      finally{message=results.join(' ');await load();}
    }
    await load();
  }
})();
