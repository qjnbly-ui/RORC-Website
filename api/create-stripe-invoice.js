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

  if (!SERVICE_ROLE_KEY || !stripe) {
    return res.status(500).json({ success: false, error: "Stripe invoice service is not configured." });
  }

  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ success: false, error: "Missing session token" });

    const user = await getSupabaseUser(token);
    const manager = await getAccountMemberByAuthUserId(user.id);
    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Admin access required" });
    }

    const itemIds = uniqueIds(req.body?.billingLineItemIds || req.body?.itemIds || []);
    if (!itemIds.length) {
      return res.status(400).json({ success: false, error: "Select at least one billing item." });
    }

    const mode = normalizeInvoiceMode(req.body?.mode || req.body?.invoiceMode);
    const billingItems = await loadBillingItems(itemIds);
    if (billingItems.length !== itemIds.length) {
      return res.status(404).json({ success: false, error: "One or more billing items could not be found." });
    }

    const openItems = billingItems.filter((item) => !item.posted_to_stripe_at);
    if (!openItems.length) {
      return res.status(409).json({ success: false, error: "Selected billing items are already paid." });
    }

    const accountId = await accountIdForBillingItems(openItems);
    const { customerId, billingOwner } = await ensureStripeCustomerForAccount(accountId);
    const invoice = await createStripeInvoice({
      accountId,
      customerId,
      billingItems: openItems,
      mode
    });

    const invoiceUrl = invoice.hosted_invoice_url || "";
    const paidAt = mode === "paid" ? new Date().toISOString() : null;
    await updateBillingItemsForInvoice({
      itemIds: openItems.map((item) => item.id),
      invoice,
      invoiceUrl,
      mode,
      paidAt,
      managerId: manager.id
    });

    if (paidAt) {
      await syncRelatedPaidState(openItems, true);
    }

    return res.status(200).json({
      success: true,
      invoice: {
        id: invoice.id,
        number: invoice.number || "",
        status: invoice.status || "",
        url: invoiceUrl,
        customerId,
        customerEmail: billingOwner?.email_address || ""
      },
      itemIds: openItems.map((item) => item.id)
    });
  } catch (error) {
    console.error("create-stripe-invoice error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Could not create Stripe invoice."
    });
  }
};

async function createStripeInvoice({ accountId, customerId, billingItems, mode }) {
  const chargeItems = billingItems.filter((item) => Number(item.amount_cents || 0) > 0);
  if (!chargeItems.length) {
    throw httpError(400, "Stripe invoices require at least one charge greater than $0.");
  }

  for (const item of chargeItems) {
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: Number(item.amount_cents || 0),
      currency: "usd",
      description: invoiceItemDescription(item),
      metadata: {
        rorc_billing_line_item_id: item.id,
        rorc_account_id: accountId
      }
    });
  }

  const draft = await stripe.invoices.create({
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: mode === "paid" ? 0 : 30,
    auto_advance: false,
    metadata: {
      rorc_account_id: accountId,
      rorc_billing_line_item_ids: billingItems.map((item) => item.id).join(",")
    },
    footer: "Thank you for supporting Ruth Obenchain Recreation Center."
  });

  const finalized = await stripe.invoices.finalizeInvoice(draft.id);
  if (mode === "paid") {
    return stripe.invoices.pay(finalized.id, { paid_out_of_band: true });
  }
  return stripe.invoices.sendInvoice(finalized.id);
}

function invoiceItemDescription(item) {
  const reason = String(item.reason || "RORC billing item").trim();
  if (item.rental_request_id) return `Rental: ${reason}`;
  if (item.heater_use_entry_id) return `Thermostat: ${reason}`;
  if (item.timesheet_entry_id) return `Guest entry: ${reason}`;
  return reason;
}

async function loadBillingItems(itemIds) {
  const ids = itemIds.map((id) => `"${String(id).replaceAll("\"", "")}"`).join(",");
  return supabaseRest(
    `billing_line_items?select=*&id=in.(${encodeURIComponent(ids)})`
  );
}

async function accountIdForBillingItems(items) {
  const memberIds = uniqueIds(items.map((item) => item.account_member_id));
  const ids = memberIds.map((id) => `"${String(id).replaceAll("\"", "")}"`).join(",");
  const members = await supabaseRest(
    `account_members?select=id,account_id&id=in.(${encodeURIComponent(ids)})`
  );
  const accountIds = uniqueIds((members || []).map((member) => member.account_id));
  if (accountIds.length !== 1) {
    throw httpError(409, "Selected billing items must belong to one account.");
  }
  return accountIds[0];
}

async function ensureStripeCustomerForAccount(accountId) {
  const billingRows = await supabaseRest(
    `account_billing?select=account_id,stripe_customer_id&account_id=eq.${encodeURIComponent(accountId)}&limit=1`
  ).catch(() => []);
  const existingCustomerId = String(billingRows?.[0]?.stripe_customer_id || "").trim();
  const billingOwner = await loadBillingOwner(accountId);
  if (existingCustomerId) return { customerId: existingCustomerId, billingOwner };

  if (!billingOwner?.email_address) {
    throw httpError(409, "This account needs a billing owner email before a Stripe invoice can be created.");
  }

  const customer = await stripe.customers.create({
    email: billingOwner.email_address,
    name: billingOwner.member_name || undefined,
    phone: billingOwner.phone_number || undefined,
    metadata: {
      rorc_account_id: accountId,
      rorc_account_number: billingOwner.account_number || ""
    }
  });

  await upsertAccountBilling(accountId, { stripe_customer_id: customer.id });
  return { customerId: customer.id, billingOwner };
}

async function loadBillingOwner(accountId) {
  const rows = await supabaseRest(
    `account_members?select=id,account_id,member_name,email_address,phone_number,is_billing_owner,accounts(account_number)&account_id=eq.${encodeURIComponent(accountId)}&order=is_billing_owner.desc&limit=10`
  );
  const owner = (rows || []).find((row) => row.is_billing_owner) || rows?.[0];
  if (!owner) throw httpError(409, "No billing owner found for this account.");
  return {
    ...owner,
    account_number: owner.accounts?.account_number || ""
  };
}

async function upsertAccountBilling(accountId, patch) {
  const existing = await supabaseRest(
    `account_billing?select=account_id&account_id=eq.${encodeURIComponent(accountId)}&limit=1`
  ).catch(() => []);
  if (existing.length) {
    await updateSupabaseRows(`account_billing?account_id=eq.${encodeURIComponent(accountId)}`, patch);
    return;
  }
  await insertSupabaseRow("account_billing", {
    account_id: accountId,
    ...patch
  });
}

async function updateBillingItemsForInvoice({ itemIds, invoice, invoiceUrl, mode, paidAt, managerId }) {
  const ids = itemIds.map((id) => `"${String(id).replaceAll("\"", "")}"`).join(",");
  const payload = {
    payment_method: "stripe_invoice",
    stripe_invoice_id: invoice.id,
    stripe_invoice_url: invoiceUrl || null,
    payment_note: mode === "paid" ? "Stripe invoice marked paid out of band." : null,
    posted_to_stripe_at: paidAt,
    payment_recorded_at: paidAt,
    payment_recorded_by_member_id: paidAt ? managerId : null
  };
  await updateSupabaseRows(`billing_line_items?id=in.(${encodeURIComponent(ids)})`, payload);
}

async function syncRelatedPaidState(items, paid) {
  const rentalIds = uniqueIds(items.map((item) => item.rental_request_id).filter(Boolean));
  const heaterIds = uniqueIds(items.map((item) => item.heater_use_entry_id).filter(Boolean));
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
  if (!response.ok) throw httpError(401, "Invalid session");
  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(
    `account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
  );
  return rows[0] || null;
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

function normalizeInvoiceMode(value) {
  return String(value || "").trim().toLowerCase() === "paid" ? "paid" : "send";
}

function uniqueIds(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
