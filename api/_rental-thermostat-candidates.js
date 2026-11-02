// Optional event association used by the individual rental workflow.
function rentalThermostatAddonSystemTypes(rental) {
  const systems=[];
  if(rental?.addon_heater) systems.push('heat');
  if(rental?.addon_ac) systems.push('ac');
  return systems;
}
function isThermostatCandidateForRental(heater,rental,groupMemberIds=[]) {
  if(!heater?.id || !rental?.id || String(heater.used_on || '')!==String(rental.event_date || '')) return false;
  const system=String(heater.system_type || '').trim().toLowerCase()==='ac'?'ac':'heat';
  if(rentalThermostatAddonSystemTypes(rental).includes(system)) return true;
  const memberId=String(rental.claimed_member_id || '');
  return Boolean(memberId) && (String(heater.responsible_member_id || '')===memberId || groupMemberIds.map(String).includes(memberId));
}
module.exports={rentalThermostatAddonSystemTypes,isThermostatCandidateForRental};
