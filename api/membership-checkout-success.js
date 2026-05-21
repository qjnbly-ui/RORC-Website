const Stripe = require("stripe");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" })
  : null;

module.exports = async (req, res) => {
  try {
    if (!SERVICE_ROLE_KEY || !stripe) {
      throw new Error("Checkout success handler is not configured.");
    }

    const sessionId = String(req.query?.session_id || "").trim();
    if (!sessionId) {
      throw new Error("Missing checkout session.");
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"]
    });
    const metadata = session.metadata || {};
    const accountId = metadata.rorc_account_id;
    const signupContractId = metadata.rorc_signup_contract_id;
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id || "";
    const subscription = typeof session.subscription === "object" ? session.subscription : null;
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : subscription?.id || "";
    const billingStatus = subscription ? normalizeBillingStatus(subscription.status) : "active";
    const currentPeriodEnd = subscription?.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;

    if (!accountId) {
      throw new Error("Checkout session is missing RORC account metadata.");
    }

    await upsertAccountBilling({
      accountId,
      customerId,
      subscriptionId,
      billingStatus,
      currentPeriodEnd
    });

    if (signupContractId) {
      await updateSupabaseRows(
        `signup_contracts?id=eq.${encodeURIComponent(signupContractId)}`,
        { signup_status: billingStatus === "active" || billingStatus === "trialing" ? "active" : "awaiting_payment" }
      );
    }

    res.writeHead(302, {
      Location: "/member-dashboard/?signup=pending_review"
    });
    return res.end();
  } catch (error) {
    res.writeHead(302, {
      Location: `/membership-login/?signup=error&message=${encodeURIComponent(error.message || "Checkout could not be verified.")}`
    });
    return res.end();
  }
};

async function upsertAccountBilling({ accountId, customerId, subscriptionId, billingStatus, currentPeriodEnd }) {
  const existing = await supabaseRest(`account_billing?select=account_id&account_id=eq.${encodeURIComponent(accountId)}&limit=1`);
  const payload = {
    stripe_customer_id: customerId || null,
    stripe_subscription_id: subscriptionId || null,
    stripe_status: billingStatus,
    billing_status: billingStatus,
    current_period_end: currentPeriodEnd,
    last_sync: new Date().toISOString()
  };

  if (existing.length) {
    await updateSupabaseRows(`account_billing?account_id=eq.${encodeURIComponent(accountId)}`, payload);
    return;
  }

  await insertSupabaseRow("account_billing", {
    account_id: accountId,
    ...payload
  });
}

async function supabaseRest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: supabaseHeaders()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function insertSupabaseRow(table, payload) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders({ prefer: "return=representation" }),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not create ${table} row: ${response.status} ${text}`);
  }

  return response.json();
}

async function updateSupabaseRows(path, payload) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: supabaseHeaders(),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not update Supabase row: ${response.status} ${text}`);
  }
}

function supabaseHeaders({ prefer = "" } = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {})
  };
}

function normalizeBillingStatus(status) {
  const normalized = String(status || "").trim();
  if (["trialing", "active", "past_due", "canceled", "unpaid", "paused", "incomplete"].includes(normalized)) {
    return normalized;
  }

  if (normalized === "incomplete_expired") return "canceled";
  return "incomplete";
}
