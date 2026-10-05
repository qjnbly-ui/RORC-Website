// Read each existing authorized account with the caller's JWT and normal RLS.
// This endpoint never uses the service role to read account records.
const URL = (process.env.SUPABASE_URL || 'https://aedvuofiodtsgijcxyqx.supabase.co').replace(/\/+$/, '');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({success:false,error:'Method not allowed.'});
  const token = String(req.headers?.authorization || '').match(/^Bearer (.+)$/i)?.[1];
  if (!token) return res.status(401).json({success:false,error:'Please sign in.'});
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return res.status(503).json({success:false,error:'Account overview unavailable.'});
  async function read(path, memberId, options = {}) {
    const response = await fetch(`${URL}/rest/v1/${path}`, {...options,headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(memberId ? {'x-rorc-account-member':memberId} : {})}});
    if (!response.ok) throw Object.assign(new Error('Could not load your accounts.'),{status:response.status});
    return response.json();
  }
  async function readBilling(memberId) {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await read(`billing_line_items?select=id,reason,amount_cents,payment_recorded_at,stripe_invoice_status,created_at&order=created_at.desc,id.asc&limit=1000&offset=${offset}`, memberId);
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }
  try {
    const choices = await read('rpc/list_my_accounts', null, {method:'POST',body:'{}'});
    choices.sort((a,b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)));
    const accounts = await Promise.all(choices.map(async choice => {
      const id = choice.account_member_id;
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid account.');
      const [profile,billing,bookings,heater,attendance,door] = await Promise.all([
        read(`account_member_profiles?select=account_member_id,member_name,account_number,account_type,phone_number,email_address&account_member_id=eq.${id}`,id),
        readBilling(id),
        read(`rental_requests?select=id,event_name,event_date,event_start_time,event_end_time,rental_status,payment_status,estimated_total_cents&claimed_account_id=eq.${choice.account_id}&order=event_date.asc&limit=500`,id),
        read(`heater_use_entries?select=id,event,used_on,start_at,end_at,paid&responsible_member_id=eq.${id}&order=used_on.desc&limit=100`,id),
        read(`timesheet_entries?select=id,member_or_guest,guest_name,signed_in_at,signed_out_at&or=(member_id.eq.${id},member_entered_with_id.eq.${id})&order=signed_in_at.desc&limit=100`,id),
        read(`door_access_entries?select=id,access_requested_at&requested_by_member_id=eq.${id}&order=access_requested_at.desc&limit=100`,id)
      ]);
      return {profile:profile[0] || choice,billing,bookings,heater,attendance,door};
    }));
    return res.status(200).json({success:true,accounts});
  } catch(error) { return res.status([401,403].includes(error.status)?error.status:500).json({success:false,error:error.message}); }
};
