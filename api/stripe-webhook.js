const Stripe = require("stripe");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" })
  : null;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY || !stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ success: false, error: "Webhook is not configured." });
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data.object);
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await handleSubscriptionChanged(event.data.object);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Webhook failed." });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};

async function handleCheckoutCompleted(session) {
  const metadata = session.metadata || {};
  const accountId = metadata.rorc_account_id;
  const signupContractId = metadata.rorc_signup_contract_id;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : "";
  const customerId = typeof session.customer === "string" ? session.customer : "";

  if (!accountId) return;

  let billingStatus = "active";
  let currentPeriodEnd = null;

  if (subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    billingStatus = normalizeBillingStatus(subscription.status);
    currentPeriodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;
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
}

async function handleSubscriptionChanged(subscription) {
  const metadata = subscription.metadata || {};
  const accountId = metadata.rorc_account_id;
  if (!accountId) return;

  await upsertAccountBilling({
    accountId,
    customerId: typeof subscription.customer === "string" ? subscription.customer : "",
    subscriptionId: subscription.id,
    billingStatus: normalizeBillingStatus(subscription.status),
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null
  });
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

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body));

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
