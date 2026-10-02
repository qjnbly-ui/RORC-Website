const { accountMemberFilter } = require("./_account-scope");
const { buildRentalRecord } = require('./rental-reviews');
const URL = (process.env.SUPABASE_URL || 'https://aedvuofiodtsgijcxyqx.supabase.co').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const uuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
const date = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && Number.isFinite(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0,10) === v;
const time = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
function commandFromBody(body, manager) {
  const action = body.action;
  if (!['create','update','cancel','request_update','request_cancel','approve','reject'].includes(action)) throw Object.assign(new Error('Invalid operation.'), {status:400});
  if (!manager && !['request_update','request_cancel'].includes(action)) throw Object.assign(new Error('Manager access required.'), {status:403});
  const command = {action, scope: body.scope || 'this'};
  if (!['this','following','all'].includes(command.scope)) throw Object.assign(new Error('Invalid scope.'), {status:400});
  if (action === 'create') {
    if (!Array.isArray(body.rentals) || !body.rentals.length || body.rentals.length>240) throw Object.assign(new Error('Choose 1–240 rentals.'),{status:400});
    const dates = new Set();
    command.rentals = body.rentals.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('Invalid occurrence.'), {status:400});
      const ps=raw.public_event_start_time, pe=raw.public_event_end_time;
      if (Boolean(ps)!==Boolean(pe) || (ps && (!time(ps) || !time(pe) || ps>=pe))) throw Object.assign(new Error('Provide ordered public times together.'), {status:400});
      if (!date(raw.event_date) || !time(raw.event_start_time) || !time(raw.event_end_time) || raw.event_start_time >= raw.event_end_time || dates.has(raw.event_date)) throw Object.assign(new Error('Each occurrence requires a unique valid date and ordered access times.'),{status:400});
      dates.add(raw.event_date);
      for (const key of ['claimed_member_id','claimed_account_id']) if (raw[key] && !uuid(raw[key])) throw Object.assign(new Error('Invalid booking owner.'),{status:400});
      const rental = buildRentalRecord(raw);
      delete rental.reviewed_at; // Idempotency fingerprint must not contain server time.
      return rental;
    });
    command.isPublic = Boolean(body.isPublic);
  } else if (action === 'approve' || action === 'reject') {
    if (!uuid(body.changeRequestId)) throw Object.assign(new Error('Request is required.'),{status:400});
    command.changeRequestId = body.changeRequestId;
    command.reviewNotes = String(body.reviewNotes || '').slice(0,2000);
  } else {
    if (!uuid(body.rentalRequestId)) throw Object.assign(new Error('Booking is required.'),{status:400});
    command.rentalRequestId = body.rentalRequestId;
    command.patch = {};
    const allowed = ['event_name','event_date','event_start_time','event_end_time','public_event_start_time','public_event_end_time','message'];
    for (const [key,value] of Object.entries(body.patch || {})) {
      if (!allowed.includes(key)) throw Object.assign(new Error(`Unsupported booking edit: ${key}`),{status:400});
      command.patch[key] = value === null ? null : String(value).trim().slice(0,key==='message'?2000:200);
    }
    const p = command.patch;
    if (p.event_date !== undefined && !date(p.event_date)) throw Object.assign(new Error('Invalid occurrence date.'),{status:400});
    for (const key of ['event_start_time','event_end_time']) if (p[key] !== undefined && !time(p[key])) throw Object.assign(new Error('Valid access times are required.'),{status:400});
    if ((p.event_start_time !== undefined) !== (p.event_end_time !== undefined) || (p.event_start_time && p.event_start_time>=p.event_end_time)) throw Object.assign(new Error('Provide ordered access start and end times together.'),{status:400});
    if ((p.public_event_start_time !== undefined) !== (p.public_event_end_time !== undefined) || Boolean(p.public_event_start_time)!==Boolean(p.public_event_end_time) || (p.public_event_start_time && (!time(p.public_event_start_time)||!time(p.public_event_end_time)||p.public_event_start_time>=p.public_event_end_time))) throw Object.assign(new Error('Provide ordered public times together.'),{status:400});
  }
  return command;
}
async function rest(path, token, options={}) {
  const response = await fetch(`${URL}/${path}`, {...options,headers:{apikey:KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...options.headers}});
  const body = await response.json().catch(()=>({}));
  if (!response.ok) { const status = body.code==='23P01'||body.code==='23505'||body.code==='55000'?409:body.code==='42501'?403:response.status; throw Object.assign(new Error(body.message || 'Booking operation failed.'),{status}); }
  return body;
}
module.exports = async function handler(req,res) {
  if (req.method!=='POST') return res.status(405).json({success:false,error:'Method not allowed.'});
  if (!KEY) return res.status(503).json({success:false,error:'Booking service unavailable.'});
  const token = String(req.headers?.authorization || '').match(/^Bearer (.+)$/i)?.[1];
  if (!token) return res.status(401).json({success:false,error:'Sign in before managing bookings.'});
  try {
    const user = await rest('auth/v1/user',token);
    const filter = await accountMemberFilter(user.id, req, path => rest(`rest/v1/${path}`, KEY));
    const members = await rest(`rest/v1/account_members?select=id,account_type&${filter}&limit=1`,KEY);
    const member = members[0];
    if (!member) return res.status(403).json({success:false,error:'Member account required.'});
    if (!uuid(req.body?.operationId)) return res.status(400).json({success:false,error:'A unique operation ID is required.'});
    const command = commandFromBody(req.body,member.account_type==='Account Manager');
    const result = await rest('rest/v1/rpc/apply_recurring_rental_operation',KEY,{method:'POST',body:JSON.stringify({actor_id:member.id,operation_id:req.body.operationId,command})});
    return res.status(200).json(result);
  } catch(error) { return res.status(Number(error.status)||500).json({success:false,error:error.message}); }
};
module.exports.commandFromBody = commandFromBody;
