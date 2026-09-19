const Stripe = require("stripe");

// A standalone invoice: no subscription, recurring price, or automatic renewal.
async function createSponsorInvoice({ id, supabaseRest, supabaseWrite, stripe = null, mode = "create" }) {
  if (!stripe && !process.env.STRIPE_SECRET_KEY) throw fail(503, "Stripe is not configured.");
  stripe ||= Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" });
  const path = `sponsor_banner_submissions?id=eq.${encodeURIComponent(id)}`;
  let row = (await supabaseRest(`${path}&select=*&limit=1`))[0];
  if (!row) throw fail(404, "Sponsor submission was not found.");
  if (row.sponsorship_type !== "new" || Number(row.amount_cents) !== 12500) {
    throw fail(400, "This invoice option is for a $125 first-year banner only.");
  }
  if (!row.price_acknowledged) {
    throw fail(400, "The sponsor must acknowledge pricing before an invoice can be created.");
  }
  if (["paid", "complete", "canceled"].includes(row.status) && !row.stripe_invoice_id) {
    throw fail(409, "This request is already paid, complete, or canceled.");
  }
  if (mode === "send" && ["paid", "complete", "canceled"].includes(row.status)) {
    throw fail(409, "Paid, complete, or canceled requests cannot be emailed.");
  }
  const key = `sponsor-${id}`;
  const metadata = { rorc_sponsor_submission_id: id };
  let invoice;
  if (row.stripe_invoice_id) {
    invoice = await stripe.invoices.retrieve(row.stripe_invoice_id);
  } else {
    // Persist the start before contacting Stripe. Never retry beyond Stripe's
    // idempotency window without manual reconciliation of an uncertain result.
    if (!row.invoice_started_at) {
      await supabaseWrite(`${path}&invoice_started_at=is.null`, "PATCH", {
        invoice_started_at: new Date().toISOString()
      });
      row = (await supabaseRest(`${path}&select=*&limit=1`))[0];
    }
    if (!row?.invoice_started_at || Date.now() - Date.parse(row.invoice_started_at) > 23 * 60 * 60 * 1000) {
      throw fail(409, "An earlier invoice attempt needs review in Stripe before retrying. No new invoice was created.");
    }
    const customer = await stripe.customers.create({
      email: row.email_address, name: row.business_name, metadata
    }, { idempotencyKey: `${key}-customer` });
    invoice = await stripe.invoices.create({
      customer: customer.id, collection_method: "send_invoice", days_until_due: 30,
      auto_advance: false, pending_invoice_items_behavior: "exclude",
      automatic_tax: { enabled: false }, default_tax_rates: [], discounts: [],
      description: "Banner sponsorship — first year. One-time order; no automatic renewal.",
      metadata
    }, { idempotencyKey: `${key}-invoice` });
    await supabaseWrite(path, "PATCH", { stripe_invoice_id: invoice.id, stripe_invoice_status: invoice.status });
  }
  if (invoice.status === "draft") {
    const lines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
    if (!lines.data.length) {
      await stripe.invoiceItems.create({
        customer: invoice.customer, invoice: invoice.id, amount: 12500, currency: "usd",
        description: "Sponsor banner — first year (one-time order, no automatic renewal)",
        discountable: false, metadata
      }, { idempotencyKey: `${key}-line` });
    }
    invoice = await stripe.invoices.retrieve(invoice.id);
    if (invoice.total !== 12500) throw fail(409, "Invoice total must be exactly $125. Review the draft in Stripe.");
    invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false }, {
      idempotencyKey: `${key}-finalize`
    });
  }
  if (!["open", "paid"].includes(invoice.status)) {
    throw fail(409, `Existing invoice is ${invoice.status}. Review it in Stripe; no duplicate was created.`);
  }
  let sentAt = row.stripe_invoice_sent_at || null;
  const alreadySent = Boolean(sentAt);
  if (mode === "send") {
    if (invoice.status !== "open" || invoice.total !== 12500 || invoice.currency !== "usd") {
      throw fail(409, "Only an open $125 USD banner invoice can be sent. Refresh and review the invoice.");
    }
    if (String(invoice.customer_email || "").toLowerCase() !== String(row.email_address || "").toLowerCase()) {
      throw fail(409, "The invoice email does not match the sponsor. Review the recipient in Stripe before sending.");
    }
    if (!sentAt) {
      // Retried clicks reuse the same send request and the same invoice.
      invoice = await stripe.invoices.sendInvoice(invoice.id, {}, { idempotencyKey: `${key}-send` });
      sentAt = new Date().toISOString();
    }
  }
  await supabaseWrite(path, "PATCH", {
    ...(sentAt ? { stripe_invoice_sent_at: sentAt } : {}),
    stripe_invoice_id: invoice.id, stripe_invoice_url: invoice.hosted_invoice_url,
    stripe_invoice_status: invoice.status,
    ...(!["complete", "canceled"].includes(row.status) ? { status: invoice.status === "paid" ? "paid" : "invoiced" } : {})
  });
  return { id: invoice.id, url: invoice.hosted_invoice_url, status: invoice.status, sentAt, alreadySent };
}

function fail(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
module.exports = { createSponsorInvoice };
