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

  if (!SERVICE_ROLE_KEY || !stripe || !stripeWebhookSecrets().length) {
    return res.status(500).json({ success: false, error: "Webhook is not configured." });
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["stripe-signature"];
    const event = constructStripeWebhookEvent(rawBody, signature);

    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data.object);
    } else if (event.type === "customer.subscription.updated") {
      await handleSubscriptionChanged(event.data.object, { syncPlan: true });
    } else if (event.type === "customer.subscription.deleted") {
      await handleSubscriptionChanged(event.data.object, { syncPlan: false });
    } else if (event.type === "invoice.paid") {
      await handleInvoicePaid(event.data.object);
    } else if (event.type === "invoice.voided") {
      await handleInvoiceVoided(event.data.object);
    } else if (event.type === "invoice.payment_failed") {
      await handleInvoicePaymentFailed(event.data.object);
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
    await syncAccountMembershipPlan({
      accountId,
      subscription,
      supabaseRest,
      updateSupabaseRows
    });
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

async function handleSubscriptionChanged(subscription, { syncPlan }) {
  const accountId = await resolveAccountIdForSubscription(subscription);
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

  if (syncPlan) {
    await syncAccountMembershipPlan({
      accountId,
      subscription,
      supabaseRest,
      updateSupabaseRows
    });
  }
}

async function handleInvoicePaid(invoice) {
  if (!invoice?.id) return;
  const rows = await supabaseRest(
    `billing_line_items?select=*&stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`
  ).catch(() => []);
  if (!rows.length) return;

  const paidAt = invoice.status_transitions?.paid_at
    ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
    : new Date().toISOString();
  await updateSupabaseRows(
    `billing_line_items?stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`,
    {
      posted_to_stripe_at: paidAt,
      payment_recorded_at: paidAt,
      payment_method: "stripe_invoice",
      payment_note: invoice.paid_out_of_band ? "Stripe invoice marked paid out of band." : null,
      stripe_invoice_url: invoice.hosted_invoice_url || null
    }
  );
  await syncRelatedBillingState(rows, true);
}

async function handleInvoiceVoided(invoice) {
  if (!invoice?.id) return;
  const rows = await supabaseRest(
    `billing_line_items?select=*&stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`
  ).catch(() => []);
  if (!rows.length) return;
  await updateSupabaseRows(
    `billing_line_items?stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`,
    {
      posted_to_stripe_at: null,
      payment_recorded_at: null,
      payment_recorded_by_member_id: null,
      payment_note: "Stripe invoice voided.",
      stripe_invoice_url: invoice.hosted_invoice_url || null
    }
  );
  await syncRelatedBillingState(rows, false);
}

async function handleInvoicePaymentFailed(invoice) {
  if (!invoice?.id) return;
  await updateSupabaseRows(
    `billing_line_items?stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`,
    {
      payment_note: "Stripe invoice payment failed.",
      stripe_invoice_url: invoice.hosted_invoice_url || null
    }
  ).catch(() => {});
}

async function syncRelatedBillingState(rows, paid) {
  const rentalIds = uniqueIds((rows || []).map((row) => row.rental_request_id).filter(Boolean));
  const heaterIds = uniqueIds((rows || []).map((row) => row.heater_use_entry_id).filter(Boolean));

  if (rentalIds.length) {
    const ids = rentalIds.map((id) => `"${String(id).replaceAll("\"", "")}"`).join(",");
    await updateSupabaseRows(
      `rental_requests?id=in.(${encodeURIComponent(ids)})`,
      { payment_status: paid ? "paid" : "unpaid" }
    );
  }

  if (heaterIds.length) {
    const ids = heaterIds.map((id) => `"${String(id).replaceAll("\"", "")}"`).join(",");
    await updateSupabaseRows(
      `heater_use_entries?id=in.(${encodeURIComponent(ids)})`,
      { paid }
    );
  }
}

function uniqueIds(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

async function resolveAccountIdForSubscription(subscription) {
  const metadata = subscription.metadata || {};
  if (metadata.rorc_account_id) return metadata.rorc_account_id;

  if (subscription.id) {
    const subscriptionMatches = await supabaseRest(
      `account_billing?select=account_id&stripe_subscription_id=eq.${encodeURIComponent(subscription.id)}&limit=1`
    );

    if (subscriptionMatches[0]?.account_id) {
      return subscriptionMatches[0].account_id;
    }
  }

  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id || "";
  if (customerId) {
    const customerMatches = await supabaseRest(
      `account_billing?select=account_id&stripe_customer_id=eq.${encodeURIComponent(customerId)}&limit=1`
    );

    if (customerMatches[0]?.account_id) {
      return customerMatches[0].account_id;
    }
  }

  return "";
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
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody, "utf8");

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks);
  if (rawBody.length) return rawBody;

  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");

  throw new Error("Stripe webhook raw body was not available. Ensure Vercel body parsing is disabled for this endpoint.");
}

function constructStripeWebhookEvent(rawBody, signature) {
  if (!signature) throw new Error("Missing Stripe-Signature header.");

  const secrets = stripeWebhookSecrets();
  let lastError = null;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not verify Stripe webhook signature.");
}

function stripeWebhookSecrets() {
  return [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRETS
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
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
