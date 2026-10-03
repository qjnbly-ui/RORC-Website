// Short-lived form details only. Never carry account IDs, contacts, PINs or consent.
(function(root) {
  const fields = {
    heater: ['#thermostatTargetTemp','#heaterTimerDuration','#heaterTimerUntil','.heater-use-screen textarea','[data-thermostat-system]','[data-heater-timer-enabled]','[data-heater-timer-mode]'],
    memberSignIn: [],
    guestSignIn: ['#guestNameInput'],
    calendar: ['#calEvTitle','#calEvType','#calEvDate','#calEvStart','#calEvEnd','#calEvAllDay','#calEvPublic','#calEvDetailOnly','#calEvDesc','#calEvRecurring','#calRecurringEvery','#calRecurringUnit','#calRecurringCount','#calRecurringEndDate','#calRecurringExclusions','[data-rec-day]','input[name="calRecurringEndsMode"]']
  };
  function capture(host, kind, context) {
    if (!fields[kind]) throw new Error('Unknown form.');
    const entries = [];
    for (const selector of fields[kind]) [...host.querySelectorAll(selector)].forEach((field,index) => {
      if (field.tagName === 'BUTTON' && !field.classList.contains('is-selected')) return;
      entries.push({selector,index,value:String(field.value || '').slice(0,4000),checked:Boolean(field.checked),button:field.tagName === 'BUTTON'});
    });
    return {...context, kind, entries, expiresAt: Date.now() + 10 * 60_000};
  }
  function validate(draft, context) {
    if (!draft || !fields[draft.kind] || draft.userId !== context.userId || draft.memberId !== context.memberId || draft.route !== context.route || !Number.isFinite(draft.expiresAt) || draft.expiresAt <= Date.now() || draft.expiresAt > Date.now()+10*60_000 || !Array.isArray(draft.entries) || draft.entries.length>100) return null;
    if (draft.entries.some(entry=>!fields[draft.kind].includes(entry.selector) || !Number.isInteger(entry.index) || entry.index<0 || entry.index>20 || typeof entry.value!=='string' || entry.value.length>4000 || typeof entry.checked!=='boolean' || typeof entry.button!=='boolean')) return null;
    return draft;
  }
  function restore(host, draft) {
    // Segment handlers run first, then restore values they may initialize.
    for (const entry of [...draft.entries].sort((a,b)=>Number(b.button)-Number(a.button))) {
      const field = host.querySelectorAll(entry.selector)[entry.index];
      if (!field) continue;
      if (entry.button) { if (field.tagName === 'BUTTON') field.click(); continue; }
      field.value=entry.value;
      if (field.type==='checkbox' || field.type==='radio') field.checked=entry.checked;
    }
  }
  const api={capture,validate,restore};
  if (typeof module !== 'undefined') module.exports=api;
  else root.RORCAccountFormDraft=api;
})(typeof window === 'undefined' ? globalThis : window);
