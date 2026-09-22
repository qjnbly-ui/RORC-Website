"use strict";
(() => {
    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
    const date = (value) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
    const stateLabel = (row) => row.state === 'ready' ? (row.amount_cents ? 'Ready' : 'No eligible charge') : ({ pending: 'Not previewed', review: 'Needs review', excluded: 'Excluded', applying: 'Check / retry', applied: 'Credit issued' }[row.state] || row.state);
    async function mount({ root, token, confirm }) {
        let closures = [];
        let closure = null;
        let rows = [];
        let busy = false;
        let message = '';
        let errors = [];
        let reviewed = false;
        let form = { starts_on: '', reopens_on: '', reason: 'Extended maintenance closure' };
        root.className = 'closure-credits-page';
        async function api(action, data = {}) {
            const session = token();
            if (!session)
                throw new Error('Please sign in again.');
            const response = await fetch('/api/closure-credits', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
                body: JSON.stringify({ action, ...(closure ? { closure_id: closure.id } : {}), ...data })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok)
                throw new Error(payload.error || 'The request could not complete. Refresh to check progress.');
            return payload;
        }
        async function refresh() {
            if (closure) {
                const result = await api('get');
                closure = result.closure;
                rows = result.rows;
            }
            closures = (await api('list')).closures;
        }
        function draw() {
            if (!root.isConnected)
                return;
            const ready = rows.filter(r => r.state === 'ready' && r.amount_cents > 0);
            const total = ready.reduce((n, r) => n + r.amount_cents, 0);
            const issued = rows.filter(r => r.state === 'applied');
            const unresolved = rows.some(r => r.state === 'pending' || r.state === 'review');
            const retry = rows.some(r => r.state === 'applying' || (r.state === 'ready' && r.amount_cents > 0));
            const disabled = busy ? 'disabled' : '';
            root.innerHTML = `
        <section class="closure-card">
          <span class="eyebrow">Membership billing</span><h2>Closure credits</h2>
          <p>After the gym reopens, credit paid Weight Room, Full Facility, and Full Facility + Wi-Fi memberships for the closed days.</p>
          <p class="closure-muted">Each credit reduces the account’s next finalized Stripe invoice, which may be a membership or another charge. Any unused balance carries forward. Creating a preview does not issue credits.</p>
        </section>
        <p class="closure-status" role="status" aria-live="polite">${escape(message)}</p>
        ${errors.length ? `<div class="closure-error" role="alert">${errors.map(e => `<p>${escape(e)}</p>`).join('')}</div>` : ''}
        ${closure ? `
          <section class="closure-card">
            <div class="closure-heading"><h3>${escape(closure.reason)}</h3><span class="closure-badge">${escape(closure.status)}</span></div>
            <p>Closed ${escape(date(closure.starts_on))} · Reopened ${escape(date(closure.reopens_on))}</p>
            <p class="closure-muted">The reopening day is not credited. Amounts use calendar days in America/Los_Angeles and each paid invoice’s membership period.</p>
            <div class="closure-summary"><strong>${money(total)} ready</strong><span>${ready.length} accounts ready</span><span>${money(issued.reduce((n, r) => n + r.amount_cents, 0))} issued to ${issued.length} accounts</span></div>
            ${closure.status === 'draft' ? `
              <div class="closure-actions"><button type="button" data-action="preview" ${disabled}>${rows.some(r => r.state === 'pending') ? 'Continue preview' : 'Refresh preview'}</button><button type="button" data-action="cancel" class="closure-secondary" ${disabled}>Cancel unused draft</button></div>
              <label class="closure-check"><input type="checkbox" id="closureReviewed" ${reviewed ? 'checked' : ''} ${disabled}> I reviewed prior refunds and credits, including any issued outside this tool, and excluded accounts already compensated for this closure.</label>
              <button type="button" data-action="apply" ${busy || !reviewed || unresolved || !ready.length ? 'disabled' : ''}>Apply ${money(total)} in credits</button>
              ${unresolved ? '<p class="closure-muted">Finish the preview and resolve or exclude accounts needing review before applying.</p>' : ''}
            ` : closure.status === 'applying' ? `
              <p class="closure-muted">Approved amounts are locked. Refresh or resume to finish interrupted credits. A processing account may need two minutes before retrying.</p>
              <button type="button" data-action="resume" ${busy || !retry ? 'disabled' : ''}>Resume remaining credits</button>
            ` : closure.status === 'applied' ? '<p>Credits have been issued. Members will receive them as their next invoices are finalized.</p>' : '<p>This draft was canceled. No credits were issued.</p>'}
            <div class="closure-actions"><button type="button" class="closure-secondary" data-action="refresh" ${disabled}>Refresh status</button><button type="button" class="closure-secondary" data-action="back" ${disabled}>All closures</button></div>
          </section>
          <section class="closure-card"><h3>Account review</h3>
            <p class="closure-muted">Accounts without a qualifying paid gym charge receive no credit. Accounts needing review can be excluded with a reason and handled separately.</p>
            ${rows.length ? rows.map(row => `
              <article class="closure-account">
                <div class="closure-heading"><strong>${escape(row.account_label)}</strong><strong>${money(row.amount_cents)}</strong></div>
                <p><span class="closure-badge">${escape(stateLabel(row))}</span> ${row.customer_id ? `<a href="https://dashboard.stripe.com/customers/${encodeURIComponent(row.customer_id)}" target="_blank" rel="noopener noreferrer">View in Stripe</a>` : 'No Stripe customer linked'}</p>
                ${row.note ? `<p>${escape(row.note)}</p>` : ''}
                ${(row.preview?.warnings || []).map(w => `<p class="closure-error-text">${escape(w)}</p>`).join('')}
                ${row.applied_at ? `<p class="closure-muted">Issued ${escape(new Date(row.applied_at).toLocaleString())} · ${escape(row.stripe_transaction_id)}</p>` : ''}
                ${row.preview?.details.length ? `<details><summary>Calculation details</summary><div class="closure-table-wrap"><table><thead><tr><th>Membership / period</th><th>Charge</th><th>Closed days</th><th>Credit</th></tr></thead><tbody>${row.preview.details.map(d => `<tr><td>${escape(d.plan)}<small>${escape(date(d.periodStart))} – ${escape(date(d.periodEnd))} (end excluded)</small><small>${escape(d.invoice)}</small></td><td>${money(d.chargedCents)}</td><td>${d.closedDays} / ${d.periodDays}</td><td>${money(d.creditCents)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
                ${['draft', 'applying'].includes(closure.status) && !['applied', 'applying', 'excluded'].includes(row.state) && (row.amount_cents > 0 || ['pending', 'review'].includes(row.state)) ? `<div class="closure-exclude"><label>Reason to exclude<input maxlength="500" data-exclusion="${escape(row.id)}" placeholder="For example: refund already issued" ${disabled}></label><button type="button" data-action="exclude" data-row="${escape(row.id)}" class="closure-secondary" ${disabled}>Exclude account</button></div>` : ''}
              </article>`).join('') : '<p>No Stripe-linked accounts were found.</p>'}
          </section>
        ` : `
          <section class="closure-card"><h3>Preview a closure</h3>
            <form id="closureForm">
              <div class="closure-fields"><label>First closed day<input name="starts_on" type="date" required value="${escape(form.starts_on)}" ${disabled}></label><label>Reopening date<input name="reopens_on" type="date" required value="${escape(form.reopens_on)}" ${disabled}></label></div>
              <label>Reason<input name="reason" required maxlength="200" value="${escape(form.reason)}" ${disabled}></label>
              <p class="closure-muted">Use the actual reopening date. You can use this section once normal access resumes.</p>
              <button type="submit" ${disabled}>Create preview</button>
            </form>
          </section>
          <section class="closure-card"><h3>Saved closures</h3>${closures.length ? closures.map(c => `<button type="button" class="closure-history closure-secondary" data-action="open" data-id="${escape(c.id)}" ${disabled}><strong>${escape(c.reason)}</strong><span>${escape(date(c.starts_on))} – ${escape(date(c.reopens_on))} · ${escape(c.status)}</span></button>`).join('') : '<p>No closures have been recorded.</p>'}</section>
        `}`;
            root.querySelector('#closureReviewed')?.addEventListener('change', event => { reviewed = event.target.checked; draw(); });
            root.querySelector('#closureForm')?.addEventListener('submit', event => {
                event.preventDefault();
                const values = new FormData(event.target);
                form = { starts_on: String(values.get('starts_on')), reopens_on: String(values.get('reopens_on')), reason: String(values.get('reason')) };
                void run(async () => { closure = (await api('create', form)).closure; await refresh(); await processRows('preview'); });
            });
            root.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => void handle(button)));
        }
        async function run(task) {
            if (busy)
                return;
            busy = true;
            errors = [];
            message = 'Working…';
            draw();
            try {
                await task();
            }
            catch (e) {
                errors.push(e.message);
            }
            finally {
                busy = false;
                message = '';
                draw();
            }
        }
        async function processRows(action) {
            const candidates = rows.filter(r => action === 'preview' ? !['excluded', 'applied', 'applying'].includes(r.state) : r.state === 'applying' || (r.state === 'ready' && r.amount_cents > 0));
            let done = 0;
            for (const row of candidates) {
                if (!root.isConnected)
                    break;
                message = `${action === 'preview' ? 'Previewing' : 'Applying'} ${done + 1} of ${candidates.length}: ${row.account_label}`;
                draw();
                try {
                    await api(action, { row_id: row.id });
                }
                catch (e) {
                    errors.push(`${row.account_label}: ${e.message}`);
                }
                done++;
            }
            await refresh();
        }
        async function handle(button) {
            const action = button.dataset.action;
            if (busy)
                return;
            if (action === 'back') {
                closure = null;
                rows = [];
                reviewed = false;
                errors = [];
                draw();
                return;
            }
            if (action === 'apply') {
                const candidates = rows.filter(r => r.state === 'ready' && r.amount_cents > 0);
                if (!await confirm({ title: 'Apply closure credits?', message: `Issue ${money(candidates.reduce((n, r) => n + r.amount_cents, 0))} in Stripe credits to ${candidates.length} accounts? Credits reduce each account’s next finalized invoice. This issues real credits and locks this preview.`, confirmLabel: 'Apply credits', cancelLabel: 'Keep preview' }))
                    return;
            }
            if (action === 'cancel' && !await confirm({ title: 'Cancel this draft?', message: 'This releases the dates so you can create a corrected preview. No credits will be issued.', confirmLabel: 'Cancel draft', cancelLabel: 'Keep draft' }))
                return;
            const exclusion = action === 'exclude' ? root.querySelector(`[data-exclusion="${button.dataset.row}"]`)?.value.trim() : '';
            if (action === 'exclude' && !exclusion) {
                errors = ['Enter a reason before excluding an account.'];
                draw();
                return;
            }
            await run(async () => {
                if (action === 'open') {
                    const result = await api('get', { closure_id: button.dataset.id });
                    closure = result.closure;
                    rows = result.rows;
                    reviewed = false;
                }
                else if (action === 'refresh')
                    await refresh();
                else if (action === 'preview') {
                    reviewed = false;
                    await processRows('preview');
                }
                else if (action === 'apply') {
                    await api('begin', { reviewed_refunds: reviewed, expected_rows: rows.map(r => ({ id: r.id, state: r.state, fingerprint: r.fingerprint, amount_cents: r.amount_cents })).sort((a, b) => a.id.localeCompare(b.id)) });
                    await refresh();
                    await processRows('apply');
                }
                else if (action === 'resume')
                    await processRows('apply');
                else if (action === 'exclude') {
                    await api('exclude', { row_id: button.dataset.row, note: exclusion });
                    reviewed = false;
                    await refresh();
                }
                else if (action === 'cancel') {
                    await api('cancel');
                    closure = null;
                    rows = [];
                    reviewed = false;
                    await refresh();
                }
            });
        }
        await run(refresh);
    }
    window.RORC_CLOSURE_CREDITS = { mount };
})();
