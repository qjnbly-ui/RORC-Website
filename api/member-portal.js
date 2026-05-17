const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    if (!SERVICE_ROLE_KEY) {
      return res.status(500).json({
        success: false,
        error: "Supabase service role key is not configured"
      });
    }

    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Missing Supabase session"
      });
    }

    const user = await getSupabaseUser(token);
    const member = await getAccountMember(user.id);

    if (!member) {
      return res.status(403).json({
        success: false,
        error: "No linked member profile found"
      });
    }

    if (!member.is_billing_owner && member.account_type !== "Account Manager") {
      return res.status(403).json({
        success: false,
        error: "Billing is managed by the account owner"
      });
    }

    const billing = await getAccountBilling(member.account_id);
    const customerId = String(billing?.stripe_customer_id || "").trim();

    if (!customerId) {
      return res.status(404).json({
        success: false,
        error: "No Stripe customer ID found for this account"
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: "https://www.ruthobenchainrc.com/member-dashboard/"
    });

    return res.status(200).json({
      success: true,
      url: session.url
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message
    });
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
    throw new Error("Invalid Supabase session");
  }

  return response.json();
}

async function getAccountMember(authUserId) {
  const params = new URLSearchParams({
    select: "id,account_id,account_type,is_billing_owner",
    auth_user_id: `eq.${authUserId}`,
    limit: "1"
  });

  const rows = await supabaseRest(`account_members?${params.toString()}`);
  return rows[0] || null;
}

async function getAccountBilling(accountId) {
  const params = new URLSearchParams({
    select: "stripe_customer_id",
    account_id: `eq.${accountId}`,
    limit: "1"
  });

  const rows = await supabaseRest(`account_billing?${params.toString()}`);
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
    throw new Error(`Supabase REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}
