// Monthly matching only writes rental_thermostat_links; it never moves or recreates charges.
const {isThermostatCandidateForRental}=require('./_rental-thermostat-candidates');
function heaterMatchesForAccount(accountId, items, data) {
  const members = new Map(data.members.map(m=>[m.id,m]));
  const rentalAccount = rental => members.get(rental.claimed_member_id)?.account_id;
  const heaterIds = [...new Set(items.filter(i=>i.heaterId).map(i=>i.heaterId))];
  return heaterIds.map(id=>{
    const heater=data.heaters.find(h=>h.id===id);
    if (!heater) return null;
    const charges=items.filter(i=>i.heaterId===id);
    const locked=charges.some(i=>i.status!=='ready');
    const allAccountRentals=data.rentals.filter(r=>rentalAccount(r)===accountId);
    const candidates=allAccountRentals.filter(r=>r.rental_status==='confirmed' && r.event_date===heater.used_on);
    const links=(data.links || []).filter(l=>l.heater_use_entry_id===id && allAccountRentals.some(r=>r.id===l.rental_request_id));
    const attached=links.filter(l=>!l.ignored_at).map(l=>allAccountRentals.find(r=>r.id===l.rental_request_id));
    const ignored=new Set(links.filter(l=>l.ignored_at).map(l=>l.rental_request_id));
    const available=candidates.filter(r=>!ignored.has(r.id));
    const groupMemberIds=(data.heaterGroupMembers || []).filter(g=>g.heater_use_entry_id===id).map(g=>g.account_member_id);
    const recognized=available.filter(r=>isThermostatCandidateForRental(heater,r,groupMemberIds));
    const clear=recognized.length===1 && !(data.changes || []).some(c=>c.rental_request_id===recognized[0].id&&c.status==='pending') ? recognized[0] : null;
    let status, rental=null;
    if (attached.length>1 || attached.some(r=>r.rental_status!=='confirmed' || r.event_date!==heater.used_on)) status='conflict';
    else if(attached.length===1){status='attached';rental=attached[0];}
    else if(!candidates.length) status='standalone';
    else if(!available.length) status='separate';
    else if(clear){status='suggested';rental=clear;}
    else status='review';
    // A shared session may be linked to a different account only when its charges are actually split.
    const foreignLinks=(data.links || []).filter(l=>l.heater_use_entry_id===id && !l.ignored_at && !allAccountRentals.some(r=>r.id===l.rental_request_id));
    const chargedAccounts=new Set(data.billing.filter(b=>b.heater_use_entry_id===id).map(b=>members.get(b.account_member_id)?.account_id).filter(Boolean));
    const foreignConflict=foreignLinks.some(l=>{const r=data.rentals.find(r=>r.id===l.rental_request_id);return !r || !chargedAccounts.has(rentalAccount(r));});
    if(foreignConflict) status='conflict';
    const describe=r=>({id:r.id,name:r.event_name || r.booking_number || 'Rental',date:r.event_date,start:r.event_start_time || '',end:r.event_end_time || ''});
    return {heaterId:id,date:heater.used_on,start:heater.start_at,end:heater.end_at,system:heater.system_type==='ac'?'AC':'Heat',amountCents:charges.reduce((n,i)=>n+i.amountCents,0),status,locked,foreignConflict,linkedRentalIds:attached.map(r=>r.id),rental:rental?describe(rental):null,candidates:candidates.map(describe),needsReview:!locked && ['suggested','review','conflict'].includes(status)};
  }).filter(Boolean);
}
module.exports={heaterMatchesForAccount};
