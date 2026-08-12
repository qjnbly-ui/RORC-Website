const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

function authorized(req) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  const authorization = String(req.headers?.authorization || req.headers?.Authorization || "");
  return Boolean(secret && authorization === `Bearer ${secret}`);
}

async function mutate(path, method, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
}

function cleanupOperations(now = new Date()) {
  const nowIso = now.toISOString();
  const metadataCutoff = new Date(now.getTime() - 180 * 86400000).toISOString();
  const lockoutCutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  return [
    { path: `rorc_receptionist_form_drafts?expires_at=lt.${encodeURIComponent(nowIso)}`, method: "DELETE" },
    { path: `rorc_receptionist_review_items?expires_at=lt.${encodeURIComponent(nowIso)}`, method: "DELETE" },
    { path: `rorc_receptionist_events?utterance_text=not.is.null&utterance_expires_at=lt.${encodeURIComponent(nowIso)}`, method: "PATCH", body: { utterance_text: null, utterance_expires_at: null } },
    { path: `rorc_receptionist_events?created_at=lt.${encodeURIComponent(metadataCutoff)}`, method: "DELETE" },
    { path: `rorc_receptionist_calls?started_at=lt.${encodeURIComponent(metadataCutoff)}`, method: "DELETE" },
    { path: `rorc_receptionist_pin_lockouts?updated_at=lt.${encodeURIComponent(lockoutCutoff)}&or=(locked_until.is.null,locked_until.lt.${encodeURIComponent(nowIso)})`, method: "DELETE" },
  ];
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
  if (!authorized(req)) return res.status(401).json({ success: false, error: "Unauthorized" });
  if (!SERVICE_KEY) return res.status(500).json({ success: false, error: "Supabase service access is not configured" });

  const now = new Date();
  const nowIso = now.toISOString();
  try {
    for (const operation of cleanupOperations(now)) await mutate(operation.path, operation.method, operation.body);
    return res.status(200).json({ success: true, completedAt: nowIso });
  } catch (error) {
    console.error("RORC receptionist cleanup failed", error);
    return res.status(500).json({ success: false, error: "Receptionist cleanup failed" });
  }
};

module.exports.authorized = authorized;
module.exports.cleanupOperations = cleanupOperations;
