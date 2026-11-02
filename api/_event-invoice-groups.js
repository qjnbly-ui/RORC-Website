// Keep each event's real charge lines together while retaining their individual products.
function groupEventInvoiceComponents(components,data) {
  const sources=new Map(data.billing.map(b=>[b.id,b]));
  const events=new Map(data.rentals.map(r=>[r.id,r]));
  return components.map((component,index)=>{
    const source=sources.get(component.billing_line_item_id);
    const eventId=component.rental_request_id || (!source?.heater_use_entry_id ? source?.rental_request_id : '') || '';
    const event=events.get(eventId);
    return {...component, rental_request_id:event?.id || '',event_id:event?.id || '',event_date:event?.event_date || '',event_label:event?`${event.event_date} · ${event.event_name || 'Rental'}${event.booking_number?` · ${event.booking_number}`:''}`.slice(0,500):'',attachmentOrder:source?.heater_use_entry_id?1:0,originalOrder:index};
  }).sort((a,b)=>{
    if(!a.event_id && !b.event_id)return a.originalOrder-b.originalOrder;
    if(!a.event_id)return 1;
    if(!b.event_id)return -1;
    return a.event_date.localeCompare(b.event_date)||a.event_id.localeCompare(b.event_id)||a.attachmentOrder-b.attachmentOrder||a.originalOrder-b.originalOrder;
  });
}
module.exports={groupEventInvoiceComponents};
