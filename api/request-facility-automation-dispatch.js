const { bearerToken } = require("./_automation-security");
const {
  dispatchFacilityAutomation,
  requestOrigin
} = require("./dispatch-facility-automation");

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co"
).replace(/\/+$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Supabase service access is not configured" });
  }

  try {
    await requireSignedInAccountMember(req);
    const result = await dispatchFacilityAutomation({ origin: requestOrigin(req) });
    return res.status(200).json({ success: true, ...result, completedAt: new Date().toISOString() });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    console.error("Authenticated facility automation dispatch failed", error);
    return res.status(status).json({
      success: false,
      error: error.message || "Facility automation dispatch failed"
    });
  }
};

async function requireSignedInAccountMember(req, fetcher = fetch, {
  serviceRoleKey = SERVICE_ROLE_KEY
} = {}) {
  const token = bearerToken(req);
  if (!token) throw httpError(401, "Missing Supabase session");
  if (!serviceRoleKey) throw httpError(500, "Supabase service access is not configured");

  const userResponse = await fetcher(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${token}`
    }
  });
  const user = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !user?.id) throw httpError(401, "Invalid Supabase session");

  const params = new URLSearchParams({
    select: "id",
    auth_user_id: `eq.${user.id}`,
    limit: "1"
  });
  const memberResponse = await fetcher(`${SUPABASE_URL}/rest/v1/account_members?${params}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  });
  const members = await memberResponse.json().catch(() => []);
  if (!memberResponse.ok) throw new Error("Could not verify facility automation access");
  if (!members[0]?.id) throw httpError(403, "No facility account is linked to this session");
  return members[0];
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports.requireSignedInAccountMember = requireSignedInAccountMember;
