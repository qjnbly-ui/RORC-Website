const { rest } = require('./_sms-booking-store');
const SETTING_ID = 'sms_booking_ai';
async function getSmsBookingSettings() {
  const rows = await rest(`automation_settings?select=config&id=eq.${SETTING_ID}&limit=1`);
  return { enabled: rows[0]?.config?.enabled === true };
}
async function setSmsBookingEnabled(enabled, managerId) {
  if (typeof enabled !== 'boolean') throw Object.assign(new Error('Choose on or off.'), { statusCode: 400 });
  await rest('automation_settings?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ id: SETTING_ID, config: { enabled, updated_by_member_id: managerId } })
  });
  return { enabled };
}
module.exports = { getSmsBookingSettings, setSmsBookingEnabled };
