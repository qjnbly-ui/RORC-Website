const Stripe = require("stripe");
const { syncAccountMembershipPlan } = require("./_stripe-membership-sync");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" })
  : null;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY || !stripe) {
    return res.status(500).json({ success: false, error: "Stripe sync is not configured." });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing Supabase session." });
    }

    const user = await getSupabaseUser(token);
    const actor = await getAccountMemberByAuthUserId(user.id);
    if (!actor) {
      return res.status(403).json({ success: false, error: "Signed-in member profile is not linked." });
    }

    const requestedAccountId = String(req.body?.accountId || "").trim();
    const canSyncRequestedAccount = actor.account_type === "Account Manager" && requestedAccountId;
    const targetAccountId = canSyncRequestedAccount ? requestedAccountId : actor.account_id;

    if (actor.account_type !== "Account Manager" && !actor.is_billing_owner) {
      return res.status(403).json({ success: false, error: "Only billing owners or account managers can sync billing." });
    }

    const billing = await getAccountBilling(targetAccountId);
    const subscription = await resolveSubscription(billing);

    if (!subscription) {
      return res.status(404).json({ success: false, error: "No Stripe subscription found for this account." });
    }

    const billingStatus = normalizeBillingStatus(subscription.status);
    await upsertAccountBilling({
      accountId: targetAccountId,
      customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id || billing?.stripe_customer_id || "",
      subscriptionId: subscription.id,
      billingStatus,
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null
    });

    const planSync = billingStatus === "canceled"
      ? { synced: false, plan: null, updatedMemberCount: 0 }
      : await syncAccountMembershipPlan({
        accountId: targetAccountId,
        subscription,
        supabaseRest,
        updateSupabaseRows
      });

    return res.status(200).json({
      success: true,
      billingStatus,
      planSync
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Could not sync Stripe membership." });
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

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(
    `account_members?select=id,account_id,account_type,is_billing_owner&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
  );
  return rows[0] || null;
}

async function getAccountBilling(accountId) {
  const rows = await supabaseRest(
    `account_billing?select=account_id,stripe_customer_id,stripe_subscription_id&account_id=eq.${encodeURIComponent(accountId)}&limit=1`
  );
  return rows[0] || null;
}

async function resolveSubscription(billing) {
  const subscriptionId = String(billing?.stripe_subscription_id || "").trim();
  if (subscriptionId) {
    return stripe.subscriptions.retrieve(subscriptionId);
  }

  const customerId = String(billing?.stripe_customer_id || "").trim();
  if (!customerId) return null;

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10
  });

  return (subscriptions.data || []).find((subscription) => (
    ["trialing", "active", "past_due", "unpaid", "incomplete"].includes(subscription.status)
  )) || subscriptions.data?.[0] || null;
}

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
