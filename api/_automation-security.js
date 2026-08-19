const SUPABASE_URL = String(
  process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co"
).replace(/\/+$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

function bearerToken(req) {
  const match = String(req.headers?.authorization || req.headers?.Authorization || "")
    .match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isCronAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  return Boolean(secret && bearerToken(req) === secret);
}

function requireCronAuthorization(req, res) {
  if (!String(process.env.CRON_SECRET || "").trim()) {
    res.status(500).json({ success: false, error: "Automation authentication is not configured" });
    return false;
  }
  if (!isCronAuthorized(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

async function requireFacilityOperator(req, fetcher = fetch) {
  if (!SERVICE_ROLE_KEY) {
    const error = new Error("Supabase service access is not configured");
    error.statusCode = 500;
    throw error;
  }
  const token = bearerToken(req);
  if (!token) {
    const error = new Error("Missing Supabase session");
    error.statusCode = 401;
    throw error;
  }
  const userResponse = await fetcher(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` }
  });
  const user = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !user?.id) {
    const error = new Error("Invalid Supabase session");
    error.statusCode = 401;
    throw error;
  }
  const params = new URLSearchParams({
    select: "id,account_type",
    auth_user_id: `eq.${user.id}`,
    limit: "1"
  });
  const memberResponse = await fetcher(`${SUPABASE_URL}/rest/v1/account_members?${params}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
  });
  const rows = await memberResponse.json().catch(() => []);
  if (!memberResponse.ok) throw new Error("Could not verify facility-control access");
  const member = rows[0];
  if (!member || !["Account Manager", "Kiosk Account"].includes(member.account_type)) {
    const error = new Error("Only facility operators can control gym lights");
    error.statusCode = 403;
    throw error;
  }
  return member;
}

module.exports = {
  bearerToken,
  isCronAuthorized,
  requireCronAuthorization,
  requireFacilityOperator
};
