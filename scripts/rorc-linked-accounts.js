(function(root) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(cents || 0)/100);
  function date(value) {
    if (!value) return 'Not set';
    const only = /^\d{4}-\d{2}-\d{2}$/.test(value);
    return new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric',...(only?{}:{hour:'numeric',minute:'2-digit'})}).format(new Date(only ? `${value}T12:00:00-08:00` : value));
  }
  const paid = row => Boolean(row.payment_recorded_at) || ['paid','void'].includes(row.stripe_invoice_status);
  function rows(items, render, empty) {
    return items.length ? `<ul class="linked-account-records">${items.map(item=>`<li>${render(item)}</li>`).join('')}</ul>` : `<p class="linked-account-muted">${esc(empty)}</p>`;
  }
  function render(accounts) {
    return `<h2>Your accounts</h2>${accounts.map(account=>{
      const p=account.profile;
      const upcoming=account.bookings.filter(b=>b.rental_status==='confirmed' && b.event_date >= new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
      const balance=account.billing.filter(b=>!paid(b)).reduce((n,b)=>n+Number(b.amount_cents||0),0);
      return `<section class="linked-account-card"><header><div><h3>${esc(p.member_name)}</h3><p>${esc(p.account_number)} · ${esc(p.account_type || '')}</p></div><strong>${money(balance)}<small>Open charges</small></strong></header>
        <details open><summary>Bookings · ${upcoming.length} upcoming</summary>${rows(upcoming,b=>`<div><strong>${esc(b.event_name)}</strong><span>${esc(date(b.event_date))} · ${esc(b.event_start_time)}–${esc(b.event_end_time)}</span></div><b>${money(b.estimated_total_cents)}</b>`,'No upcoming rental bookings.')}</details>
        <details><summary>Billing</summary>${rows(account.billing,b=>`<div><strong>${esc(b.reason)}</strong><span>${esc(date(b.created_at))} · ${paid(b)?'Paid / settled':'Open'}</span></div><b>${money(b.amount_cents)}</b>`,'No billing line items.')}</details>
        <details><summary>Heater use</summary>${rows(account.heater,h=>`<div><strong>${esc(h.event || 'Heater use')}</strong><span>${esc(date(h.used_on))} · ${h.paid?'Paid':'Unpaid'}</span></div>`,'No recent heater use.')}</details>
        <details><summary>Sign-ins and guests</summary>${rows(account.attendance,a=>`<div><strong>${esc(a.guest_name || a.member_or_guest || 'Sign-in')}</strong><span>${esc(date(a.signed_in_at))} · ${a.signed_out_at?'Signed out':'Currently signed in'}</span></div>`,'No recent sign-ins.')}</details>
        <details><summary>Door access</summary>${rows(account.door,d=>`<span>${esc(date(d.access_requested_at))}</span>`,'No recent door access.')}</details>
        <details><summary>Contact details</summary><p>${esc(p.email_address)}<br>${esc(p.phone_number)}</p></details>
      </section>`;
    }).join('')}`;
  }
  async function mount(host, token) {
    if (!host || !token) return;
    host.innerHTML='<p class="linked-account-muted">Loading your accounts…</p>';
    try {
      const response=await fetch('/api/linked-account-overview',{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
      const body=await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || 'Could not load accounts.');
      if (host.isConnected) host.innerHTML=render(body.accounts || []);
    } catch(error) { if(host.isConnected) host.innerHTML=`<p role="alert">${esc(error.message)}</p><button type="button" data-linked-retry>Retry</button>`; host.querySelector('[data-linked-retry]')?.addEventListener('click',()=>mount(host,token)); }
  }
  root.RORC_LINKED_ACCOUNTS={mount,render};
  if(typeof module==='object') module.exports={render};
})(typeof window==='object'?window:globalThis);
