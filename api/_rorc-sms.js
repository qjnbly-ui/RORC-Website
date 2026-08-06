const twilio = require("twilio");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  return /^[1-9][0-9]{7,14}$/.test(digits) ? `+${digits}` : "";
}

async function consent(phone, status, source) {
  const phoneE164 = normalizePhone(phone);
  if (!SERVICE_KEY || !phoneE164) return null;
  const now = new Date().toISOString();
  const payload = status === "opt_in"
    ? { phone_e164: phoneE164, consent_status: "opt_in", consent_source: source, consented_at: now, opted_out_at: null }
    : { phone_e164: phoneE164, consent_status: "opt_out", consent_source: source, opted_out_at: now };
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rorc_receptionist_sms_consent?on_conflict=phone_e164`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Unable to save SMS consent.");
  return (await response.json().catch(() => []))[0] || null;
}

async function hasConsent(phone) {
  const phoneE164 = normalizePhone(phone);
  if (!SERVICE_KEY || !phoneE164) return false;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rorc_receptionist_sms_consent?select=consent_status&phone_e164=eq.${encodeURIComponent(phoneE164)}&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const rows = await response.json().catch(() => []);
  return response.ok && rows[0]?.consent_status === "opt_in";
}

async function sendSms(to, body) {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const from = normalizePhone(process.env.RORC_RECEPTIONIST_NUMBER || process.env.TWILIO_FROM_NUMBER);
  const recipient = normalizePhone(to);
  if (!accountSid || !authToken || !from || !recipient) throw new Error("RORC SMS is not configured.");
  return twilio(accountSid, authToken).messages.create({ from, to: recipient, body: String(body || "").slice(0, 1500) });
}

module.exports = { normalizePhone, consent, hasConsent, sendSms };
