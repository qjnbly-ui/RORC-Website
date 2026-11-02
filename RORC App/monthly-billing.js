(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = cents => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(cents / 100);
  function previousMonth() {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit'}).formatToParts(new Date());
    return new Date(Date.UTC(Number(parts.find(p=>p.type==='year').value), Number(parts.find(p=>p.type==='month').value)-2,1)).toISOString().slice(0,7);
  }
  const pending = item => item.deliveryPending || item.invoiceStatus === 'draft';
  const sendable = account => account.readyCents > 0 || account.items.some(pending);
  const deliveryItems = account => account.items.filter(item => item.status === 'ready' || pending(item));
  const deliveryTotal = account => deliveryItems(account).reduce((sum,item)=>sum+item.amountCents,0);
  const time = value => value ? new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'}).format(new Date(value)) : 'Unknown';
  const eventName = rental => rental ? `${rental.name} · ${rental.date} · ${rental.start.slice(0,5)}–${rental.end.slice(0,5)}` : 'Choose an event';
  let savedMonth = "";
  window.RORC_MONTHLY_BILLING = { mount };
  async function mount({ root, token, confirm, openPayments, openRentals, isActive = () => true }) {
    let month = savedMonth || previousMonth(), preview = null, busy = false, selected = new Set(), message = '', initialized = false, loadId = 0;
    const alive = () => root.isConnected && isActive() && root.dataset.billingMount === mountId;
    const mountId = `${Date.now()}-${Math.random()}`;
    root.dataset.billingMount = mountId;
    async function request(body) {
      const response = await fetch(body ? '/api/monthly-billing' : `/api/monthly-billing?month=${encodeURIComponent(month)}`, {
        method: body ? 'POST' : 'GET', cache:'no-store',
        headers: { Authorization:`Bearer ${token()}`, ...(body ? {'Content-Type':'application/json'} : {}) },
        ...(body ? {body:JSON.stringify(body)} : {})
      });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(result.error || result.errors?.join(' ') || 'Could not load monthly billing.');
      return result;
    }
    async function load() {
      const id = ++loadId;
      busy = true; render();
      try {
        const next = await request();
        if (id !== loadId || !alive()) return;
        preview = next;
        if (!initialized) {
          selected = new Set(preview.accounts.filter(a => /^(APCA|KBYD)$/i.test(a.name)).map(a=>a.accountId));
          initialized = true;
        }
      } catch (error) { if (id === loadId) { preview = null; message = error.message; } }
      finally { if (id === loadId && alive()) { busy = false; render(); } }
    }
    const invoiceLink = item => /^https:\/\/invoice\.stripe\.com\//.test(item.invoiceUrl || '') ? `<a href="${escape(item.invoiceUrl)}" target="_blank" rel="noopener">Open invoice</a>` : '';
    function render() {
      if (!alive()) return;
      const chosen = (preview?.accounts || []).filter(a=>selected.has(a.accountId));
      const unprepared = chosen.reduce((n,a)=>n+a.unbilledRentals.length,0);
      const suggested = chosen.reduce((n,a)=>n+(a.heaterMatches || []).filter(m=>m.status==='suggested'&&!m.locked).length,0);
      const unresolved = chosen.some(a=>(a.heaterMatches || []).some(m=>m.needsReview));
      const total = chosen.reduce((n,a)=>n+deliveryTotal(a)+a.rentalCents,0);
      root.innerHTML = `<section class="monthly-billing-page">
        <header class="account-page-heading"><div><p class="eyebrow">Billing</p><h2>Monthly invoices</h2><p>Bill the previous month’s rentals, heater use, and other charges together. One invoice per billing account.</p></div></header>
        <div class="monthly-billing-toolbar"><label class="monthly-billing-month"><span>Service month</span><input type="month" id="monthlyServiceMonth" value="${escape(month)}" max="${previousMonth()}" ${busy?'disabled':''}></label><button class="app-admin-btn" data-monthly-refresh ${busy?'disabled':''}>Refresh charges</button><button class="app-admin-btn" data-monthly-payments ${busy?'disabled':''}>Payments & invoices</button></div>
        <p class="monthly-billing-note">Uses the same event and heater records as Rentals. Prepare the month’s charges, then review and send.</p>
        <p role="status" aria-live="polite" class="monthly-billing-status">${escape(busy ? message || 'Loading the complete month…' : message)}</p>
        ${preview ? `<div class="monthly-billing-batch"><strong>${chosen.length} selected · ${money(total)} to bill</strong><div class="monthly-billing-actions"><button class="app-admin-btn" data-monthly-prepare ${busy||!(unprepared+suggested)?'disabled':''}>Prepare monthly invoices</button><button class="app-admin-btn app-admin-btn-primary" data-monthly-send ${busy||!chosen.some(sendable)||unprepared||unresolved||chosen.some(a=>a.issues.length)?'disabled':''}>Review & send selected invoices</button></div></div>
        ${preview.issues.length?`<div class="billing-reconciliation-alert"><strong>Needs review</strong><ul>${preview.issues.map(i=>`<li>${escape(i)}</li>`).join('')}</ul><button class="app-admin-btn" data-monthly-rentals>Review rentals</button></div>`:''}
        <div class="monthly-billing-list">${preview.accounts.map(a=>`<section class="monthly-billing-account"><header><label><input type="checkbox" data-monthly-select="${escape(a.accountId)}" ${selected.has(a.accountId)?'checked':''} ${busy?'disabled':''}><strong>${escape(a.name)}</strong></label><strong>${money(deliveryTotal(a)+a.rentalCents)} to bill</strong></header><p>${escape(a.email || 'Billing email missing')} · ${a.unbilledRentals.length} rentals to prepare · ${a.items.filter(i=>i.status==='invoiced').length} charges already invoiced · ${a.items.filter(i=>i.status==='paid').length} paid</p>
        ${a.issues.length?`<ul class="billing-reconciliation-alert">${a.issues.map(i=>`<li>${escape(i)}</li>`).join('')}</ul>`:''}
        ${renderHeaterReview(a)}
        <details><summary>All ${a.items.length+a.unbilledRentals.length} charge details</summary><div class="monthly-billing-table-wrap"><table class="monthly-billing-table"><thead><tr><th>Date</th><th>Charge</th><th>Status</th><th>Amount</th></tr></thead><tbody>${[...a.items,...a.unbilledRentals.map(r=>({...r,status:'Prepare rental',source:'Rental'}))].sort((a,b)=>a.date.localeCompare(b.date)).map(i=>`<tr><td>${escape(i.date)}</td><td><strong>${escape(i.reason)}</strong><small>${escape(i.source)}${i.eventLabel?` · Event: ${escape(i.eventLabel)}`:''}</small>${invoiceLink(i)}</td><td>${escape(pending(i)?'Awaiting invoice delivery':({ready:'Ready to invoice',invoiced:'Already invoiced',paid:'Paid'})[i.status]||i.status)}</td><td>${money(i.amountCents)}</td></tr>`).join('')}</tbody></table></div></details></section>`).join('')||'<p>No charges or unbilled rentals were found for this month.</p>'}</div>`:''}
      </section>`;
      root.querySelector('#monthlyServiceMonth')?.addEventListener('change', event=>{ if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) { event.target.value=month; return; } month=event.target.value; savedMonth=month; preview=null; message=''; initialized=false; selected.clear(); load(); });
      root.querySelector('[data-monthly-refresh]')?.addEventListener('click', ()=>{message='';load();});
      root.querySelector('[data-monthly-payments]')?.addEventListener('click', ()=>openPayments(month));
      root.querySelector('[data-monthly-rentals]')?.addEventListener('click', openRentals);
      root.querySelectorAll('[data-monthly-select]').forEach(input=>input.addEventListener('change',()=>{ input.checked?selected.add(input.dataset.monthlySelect):selected.delete(input.dataset.monthlySelect); render(); }));
      root.querySelectorAll('[data-heater-attach], [data-heater-separate]').forEach(button=>button.addEventListener('click',()=>reviewSession(button)));
      root.querySelector('[data-monthly-prepare]')?.addEventListener('click',()=>run('prepare'));
      root.querySelector('[data-monthly-send]')?.addEventListener('click',()=>run('send'));
    }
    function renderHeaterReview(account) {
      const events=account.events || [];
      const records=account.heaterMatches || [];
      const uncertain=records.filter(r=>['review','conflict'].includes(r.status) && !r.locked);
      const separate=records.filter(r=>['standalone','separate'].includes(r.status) || (r.locked&&r.status!=='attached'));
      return `${events.length?`<div class="monthly-billing-table-wrap"><table class="monthly-billing-table"><caption>Events and heater use</caption><thead><tr><th>Date / event</th><th>Rental</th><th>Heater use</th><th>Total</th></tr></thead><tbody>${events.map(event=>`<tr><td><strong>${escape(event.name)}</strong><small>${escape(event.date)}</small></td><td>${money(event.rentalCents)}</td><td>${money(event.heaterCents)}<small>${event.heaterSessions} session${event.heaterSessions===1?'':'s'}${event.pendingAttachment?' · attaches when prepared':''}</small></td><td>${money(event.totalCents)}</td></tr>`).join('')}</tbody></table></div>`:''}
        ${separate.length?`<details class="monthly-heater-review"><summary>Heater use billed separately (${separate.length})</summary>${separate.map(r=>`<p>${escape(r.date)} · ${escape(time(r.start))}–${escape(time(r.end))} · ${money(r.amountCents)}<br><small>${r.locked?'Already invoiced without a saved event attachment.':r.status==='standalone'?'No rental for this account on this date.':'Reviewed as separate from the rental.'}</small></p>`).join('')}</details>`:''}
        ${uncertain.length?`<section class="monthly-heater-review"><h3>Heater use to review (${uncertain.length})</h3><p>Rentals found more than one possible event, or an existing attachment needs attention.</p>${uncertain.map(record=>`<div class="monthly-heater-session"><p><strong>${escape(record.system)} · ${escape(record.date)} · ${escape(time(record.start))}–${escape(time(record.end))} · ${money(record.amountCents)}</strong></p>${record.foreignConflict?'<p>Review the billing account in Rentals.</p>':`<div class="monthly-heater-controls"><label>Event rental<select data-heater-choice="${escape(account.accountId)}:${escape(record.heaterId)}"><option value="">Choose event</option>${record.candidates.map(r=>`<option value="${escape(r.id)}">${escape(eventName(r))}</option>`).join('')}</select></label><button class="app-admin-btn" data-heater-attach data-account="${escape(account.accountId)}" data-heater="${escape(record.heaterId)}">Attach</button><button class="app-admin-btn" data-heater-separate data-account="${escape(account.accountId)}" data-heater="${escape(record.heaterId)}">Bill separately</button></div>`}</div>`).join('')}</section>`:''}`;
    }
    async function reviewSession(button) {
      if(busy || !preview) return;
      const account=preview.accounts.find(a=>a.accountId===button.dataset.account);
      const heaterId=button.dataset.heater;
      const action=button.hasAttribute('data-heater-attach')?'attach':'separate';
      const select=[...root.querySelectorAll('[data-heater-choice]')].find(el=>el.dataset.heaterChoice===`${account.accountId}:${heaterId}`);
      if(action==='attach'&&!select?.value){message='Choose an event rental first.';render();return;}
      busy=true;message='Saving heater-to-event review…';
      const rentalId=select?.value;
      render();
      try { await request({action,month,accountId:account.accountId,heaterId,rentalId,fingerprint:account.fingerprint});message=action==='attach'?'Heater session attached. The existing charge and payment status were preserved.':'Heater session will be billed separately from the rental.'; }
      catch(error){message=error.message;}
      finally{await load();}
    }
    async function run(action) {
      if (busy || !preview) return;
      const accounts = preview.accounts.filter(a=>selected.has(a.accountId) && (action==='match' ? (a.heaterMatches || []).some(m=>m.status==='suggested'&&!m.locked) : action==='prepare' ? (a.unbilledRentals.length || (a.heaterMatches || []).some(m=>m.status==='suggested'&&!m.locked)) && !a.issues.length : sendable(a) && !a.issues.length && !(a.heaterMatches || []).some(m=>m.needsReview)));
      if (!accounts.length) { message='No eligible accounts selected. Resolve the review items first.'; render(); return; }
      if (action==='send') {
        const confirmed = await confirm({title:`Send ${month} invoices?`,message:'Each account receives one itemized invoice for this service month. Already invoiced charges will not be billed again.',detailHtml:`<ul class="monthly-billing-confirm">${accounts.map(a=>`<li><strong>${escape(a.name)} · ${money(deliveryTotal(a))}</strong><span>${escape(a.email)}</span><ul>${deliveryItems(a).map(i=>`<li>${escape(i.date)} · ${escape(i.reason)}${i.eventLabel?` · Event: ${escape(i.eventLabel)}`:''} · ${money(i.amountCents)}</li>`).join('')}</ul></li>`).join('')}</ul>`,confirmLabel:'Send invoices',cancelLabel:'Keep reviewing'});
        if (!confirmed || !alive()) return;
      }
      busy=true;
      const results=[];
      try {
        for (const account of accounts) {
          message=`${action==='match'?'Matching':action==='prepare'?'Preparing':'Sending'} ${account.name}…`;render();
          try {
            const result = await request({action,month,accountId:account.accountId,fingerprint:account.fingerprint});
            results.push(`${account.name}: ${action==='match'?`${result.matched} heater sessions attached`:action==='prepare'?`${result.prepared} rental charges prepared; ${result.matched || 0} heater sessions attached`:'invoice ready in Stripe'}.`);
          } catch (error) { results.push(`${account.name}: ${error.message}`); }
        }
      } finally { message=results.join(' '); await load(); }
    }
    await load();
  }
})();
