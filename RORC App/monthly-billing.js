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
  let savedMonth = "";
  window.RORC_MONTHLY_BILLING = { mount };
  async function mount({ root, token, confirm, openPayments, openRentals, isActive = () => true, readOnly = false }) {
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
      const total = chosen.reduce((n,a)=>n+deliveryTotal(a)+a.unbilledEstimateCents,0);
      root.innerHTML = `<section class="monthly-billing-page">
        <header class="account-page-heading"><div><p class="eyebrow">Billing</p><h2>Monthly invoices</h2><p>Bill the previous month’s rentals, heater use, and other charges together. One invoice per billing account.</p></div></header>
        <div class="monthly-billing-toolbar"><label class="monthly-billing-month"><span>Service month</span><input type="month" id="monthlyServiceMonth" value="${escape(month)}" max="${previousMonth()}" ${busy?'disabled':''}></label><button class="app-admin-btn" data-monthly-refresh ${busy?'disabled':''}>Refresh charges</button><button class="app-admin-btn" data-monthly-payments ${busy?'disabled':''}>Payments & invoices</button></div>
        <p class="monthly-billing-note">Rentals use the event date; heater use uses the runtime date. Other charges use their service date when available, otherwise the charge date. Preparing charges does not send invoices.</p>
        <p role="status" aria-live="polite" class="monthly-billing-status">${escape(busy ? message || 'Loading the complete month…' : message)}</p>
        ${preview ? `<div class="monthly-billing-batch"><strong>${chosen.length} selected · ${money(total)} to bill</strong><div class="monthly-billing-actions"><button class="app-admin-btn" data-monthly-prepare ${busy||readOnly||!unprepared?'disabled':''}>Prepare monthly charges${unprepared?` (${unprepared})`:''}</button><button class="app-admin-btn app-admin-btn-primary" data-monthly-send ${busy||readOnly||!chosen.some(sendable)||unprepared||chosen.some(a=>a.issues.length)?'disabled':''}>Review & send selected invoices</button></div></div>
        ${preview.issues.length?`<div class="billing-reconciliation-alert"><strong>Needs review</strong><ul>${preview.issues.map(i=>`<li>${escape(i)}</li>`).join('')}</ul><button class="app-admin-btn" data-monthly-rentals>Review rentals</button></div>`:''}
        <div class="monthly-billing-list">${preview.accounts.map(a=>`<section class="monthly-billing-account"><header><label><input type="checkbox" data-monthly-select="${escape(a.accountId)}" ${selected.has(a.accountId)?'checked':''} ${busy?'disabled':''}><strong>${escape(a.name)}</strong></label><strong>${money(deliveryTotal(a)+a.unbilledEstimateCents)} to bill</strong></header><p>${escape(a.email || 'Billing email missing')} · ${a.unbilledRentals.length} rentals to prepare · ${a.items.filter(i=>i.status==='invoiced').length} charges already invoiced · ${a.items.filter(i=>i.status==='paid').length} paid</p>
        ${a.issues.length?`<ul class="billing-reconciliation-alert">${a.issues.map(i=>`<li>${escape(i)}</li>`).join('')}</ul>`:''}
        <details ${selected.has(a.accountId)?'open':''}><summary>Review ${a.items.length+a.unbilledRentals.length} charges</summary><div class="monthly-billing-table-wrap"><table class="monthly-billing-table"><thead><tr><th>Date</th><th>Charge</th><th>Status</th><th>Amount</th></tr></thead><tbody>${[...a.items,...a.unbilledRentals.map(r=>({...r,status:'Prepare rental',source:'Rental'}))].sort((a,b)=>a.date.localeCompare(b.date)).map(i=>`<tr><td>${escape(i.date)}</td><td><strong>${escape(i.reason)}</strong><small>${escape(i.source)}</small>${invoiceLink(i)}</td><td>${escape(pending(i)?'Awaiting invoice delivery':({ready:'Ready to invoice',invoiced:'Already invoiced',paid:'Paid'})[i.status]||i.status)}</td><td>${money(i.amountCents)}</td></tr>`).join('')}</tbody></table></div></details></section>`).join('')||'<p>No charges or unbilled rentals were found for this month.</p>'}</div>`:''}
      </section>`;
      root.querySelector('#monthlyServiceMonth')?.addEventListener('change', event=>{ if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) { event.target.value=month; return; } month=event.target.value; savedMonth=month; preview=null; message=''; initialized=false; selected.clear(); load(); });
      root.querySelector('[data-monthly-refresh]')?.addEventListener('click', ()=>{message='';load();});
      root.querySelector('[data-monthly-payments]')?.addEventListener('click', ()=>openPayments(month));
      root.querySelector('[data-monthly-rentals]')?.addEventListener('click', openRentals);
      root.querySelectorAll('[data-monthly-select]').forEach(input=>input.addEventListener('change',()=>{ input.checked?selected.add(input.dataset.monthlySelect):selected.delete(input.dataset.monthlySelect); render(); }));
      root.querySelector('[data-monthly-prepare]')?.addEventListener('click',()=>run('prepare'));
      root.querySelector('[data-monthly-send]')?.addEventListener('click',()=>run('send'));
    }
    async function run(action) {
      if (busy || readOnly || !preview) return;
      const accounts = preview.accounts.filter(a=>selected.has(a.accountId) && (action==='prepare' ? a.unbilledRentals.length && !a.issues.length : sendable(a) && !a.issues.length));
      if (!accounts.length) { message='No eligible accounts selected. Resolve the review items first.'; render(); return; }
      if (action==='send') {
        const confirmed = await confirm({title:`Send ${month} invoices?`,message:'Each account receives one itemized invoice for this service month. Already invoiced charges will not be billed again.',detailHtml:`<ul class="monthly-billing-confirm">${accounts.map(a=>`<li><strong>${escape(a.name)} · ${money(deliveryTotal(a))}</strong><span>${escape(a.email)}</span><ul>${deliveryItems(a).map(i=>`<li>${escape(i.date)} · ${escape(i.reason)} · ${money(i.amountCents)}</li>`).join('')}</ul></li>`).join('')}</ul>`,confirmLabel:'Send invoices',cancelLabel:'Keep reviewing'});
        if (!confirmed || !alive()) return;
      }
      busy=true;
      const results=[];
      try {
        for (const account of accounts) {
          message=`${action==='prepare'?'Preparing':'Sending'} ${account.name}…`;render();
          try {
            const result = await request({action,month,accountId:account.accountId,fingerprint:account.fingerprint});
            results.push(`${account.name}: ${action==='prepare'?`${result.prepared} rental charges prepared`:'invoice ready in Stripe'}.`);
          } catch (error) { results.push(`${account.name}: ${error.message}`); }
        }
      } finally { message=results.join(' '); await load(); }
    }
    await load();
  }
})();
