const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  return /^[1-9][0-9]{7,14}$/.test(digits) ? `+${digits}` : "";
}

async function rest(path, options = {}) {
  if (!SERVICE_KEY) throw new Error("Supabase service access is not configured.");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(data?.message || data?.error || "Supabase request failed."));
  return data;
}

async function getCallerAccount(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const rows = await rest("account_members?select=id,account_id,member_name,account_type,phone_number&phone_number=not.is.null&limit=10000");
  const matches = (Array.isArray(rows) ? rows : []).filter((row) => normalizePhone(row.phone_number) === normalized);
  if (matches.length !== 1) return matches.length > 1 ? { ambiguous: true } : null;
  const member = matches[0];
  const accounts = await rest(`accounts?select=id,account_number,membership_details,expiration_date,heater_pin&id=eq.${encodeURIComponent(member.account_id)}&limit=1`);
  const account = accounts[0] || null;
  if (!account) return null;
  const billing = await rest(`account_billing?select=billing_status,stripe_status,current_period_end&account_id=eq.${encodeURIComponent(member.account_id)}&limit=1`).catch(() => []);
  return { member, account, billing: billing[0] || null };
}

function verifyAccountPin(caller, pin) {
  return Boolean(caller?.account?.heater_pin && /^\d{4}$/.test(String(pin || "")) && String(caller.account.heater_pin) === String(pin));
}

function accountOverview(caller) {
  const memberName = String(caller.member.member_name || "").trim();
  const type = String(caller.member.account_type || "membership").trim();
  const details = String(caller.account.membership_details || "").trim();
  const expiration = caller.account.expiration_date ? new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${caller.account.expiration_date}T00:00:00Z`)) : "not listed";
  const billing = String(caller.billing?.billing_status || caller.billing?.stripe_status || "").replace(/_/g, " ").trim();
  return `I found the RORC account for ${memberName}. The membership type is ${type}${details ? `, with these details: ${details}` : ""}. The account expiration is ${expiration}. ${billing ? `The billing status is ${billing}.` : "Billing status is not listed in the account system."}`;
}

module.exports = { getCallerAccount, verifyAccountPin, accountOverview };
