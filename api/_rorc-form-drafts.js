const crypto = require("crypto");
const { normalizePhone } = require("./_rorc-sms");
const { getFormDefinition } = require("./_rorc-forms");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function rest(path, options = {}) {
  if (!SERVICE_KEY) throw new Error("Supabase service access is not configured.");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(data?.message || data?.error || "Supabase form draft request failed."));
  return data;
}

function sanitizedAnswers(form, answers) {
  const allowed = new Set(form.fields.map((field) => field.key));
  return Object.fromEntries(Object.entries(answers || {})
    .filter(([key, value]) => allowed.has(key) && value !== null && value !== undefined && String(value).trim() !== "")
    .map(([key, value]) => [key, typeof value === "number" ? value : String(value).slice(0, 500)]));
}

async function createFormDraft(formId, answers, callerPhone) {
  const form = getFormDefinition(formId);
  if (!form) throw new Error("Unknown RORC form.");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await rest("rorc_receptionist_form_drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      token_hash: tokenHash(token),
      form_id: form.id,
      caller_phone_e164: normalizePhone(callerPhone) || null,
      answers: sanitizedAnswers(form, answers),
      expires_at: expiresAt,
    }),
  });
  if (!rows?.[0]?.id) throw new Error("Could not create the RORC form draft.");
  return { token, expiresAt, url: `${form.url}#draft=${encodeURIComponent(token)}`, form };
}

async function getFormDraft(token, expectedFormId) {
  const clean = String(token || "");
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(clean)) return null;
  const rows = await rest(`rorc_receptionist_form_drafts?select=id,form_id,answers,expires_at,draft_status&token_hash=eq.${tokenHash(clean)}&limit=1`);
  const draft = rows?.[0];
  if (!draft || draft.form_id !== expectedFormId || draft.draft_status === "expired" || new Date(draft.expires_at).getTime() <= Date.now()) return null;
  await rest(`rorc_receptionist_form_drafts?id=eq.${encodeURIComponent(draft.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ draft_status: "opened", last_opened_at: new Date().toISOString() }),
  });
  return { formId: draft.form_id, answers: draft.answers || {}, expiresAt: draft.expires_at };
}

module.exports = { tokenHash, sanitizedAnswers, createFormDraft, getFormDraft };
