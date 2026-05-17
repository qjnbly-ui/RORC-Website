const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token" });
    }

    const user = await getSupabaseUser(token);
    const manager = await getAccountMemberByAuthUserId(user.id);

    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Only account managers can edit Stripe IDs." });
    }

    const accountId = String(req.body?.accountId || "").trim();
    const stripeCustomerIdRaw = req.body?.stripeCustomerId;
    const stripeCustomerId = stripeCustomerIdRaw == null ? null : String(stripeCustomerIdRaw).trim();

    if (!accountId) {
      return res.status(400).json({ success: false, error: "Missing account ID." });
    }

    const existing = await supabaseRest(`account_billing?select=account_id&account_id=eq.${encodeURIComponent(accountId)}&limit=1`);
    const hasBillingRow = Array.isArray(existing) && existing.length > 0;

    if (hasBillingRow) {
      const patchResponse = await fetch(`${SUPABASE_URL}/rest/v1/account_billing?account_id=eq.${encodeURIComponent(accountId)}`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          stripe_customer_id: stripeCustomerId || null
        })
      });

      if (!patchResponse.ok) {
        const text = await patchResponse.text();
        throw new Error(`Could not update account billing: ${patchResponse.status} ${text}`);
      }
    } else if (stripeCustomerId) {
      const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/account_billing`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          account_id: accountId,
          stripe_customer_id: stripeCustomerId
        })
      });

      if (!insertResponse.ok) {
        const text = await insertResponse.text();
        throw new Error(`Could not create account billing row: ${insertResponse.status} ${text}`);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Server error" });
  }
};

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function getSupabaseUser(token) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error("Invalid session");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
}

async function supabaseRest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}
