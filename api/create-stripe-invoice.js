const Stripe = require("stripe");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" })
  : null;
const RENTAL_PRICE_CENTS = {
  allDay: 10000,
  privateHourly: 1000,
  nonPrivateHourly: 500,
  cleaningMaintenance: 2000,
  tables: 2000,
  chairs: 2000,
  tarp: 2000,
  earlySetup: 5000,
  earlyDayRental: 10000,
  lateCleanup: 5000,
  lateDayRental: 10000
};
const SPECIAL_ACCESS_RENTAL_DISCOUNT_RATE = 0.2;
const STRIPE_PRODUCT_CATALOG = {
  rental_base: {
    name: "Gym Rental Flat Rate",
    description: "Base facility rental charge"
  },
  maintenance: {
    name: "Standard Maintenance Fee",
    description: "Standard maintenance and cleaning fee for rentals"
  },
  tables: {
    name: "Tables Rental",
    description: "Rental table setup option"
  },
  chairs: {
    name: "Chairs Rental",
    description: "Rental chair setup option"
  },
  tarp: {
    name: "Tarp Fee",
    description: "Rental tarp setup option"
  },
  heater_addon: {
    name: "Heater Use",
    description: "Rental heater add-on selection"
  },
  ac_addon: {
    name: "Air Conditioning Operating Cost",
    description: "Rental AC add-on selection"
  },
  early_setup: {
    name: "Early Setup Fee",
    description: "Early setup rental access"
  },
  early_day: {
    name: "Gym Rental Flat Rate",
    description: "Additional full day before rental"
  },
  late_cleanup: {
    name: "Late Cleanup Fee",
    description: "Late cleanup rental access"
  },
  late_day: {
    name: "Gym Rental Flat Rate",
    description: "Additional full day after rental"
  },
  rental_adjustment: {
    name: "Gym Rental Flat Rate",
    description: "Manual rental bill adjustment"
  },
  thermostat: {
    name: "Air Conditioning Operating Cost",
    description: "Thermostat runtime charge"
  },
  ac_runtime: {
    name: "Air Conditioning Operating Cost",
    description: "Air conditioning runtime charge"
  },
  heater_use: {
    name: "Heater Use",
    description: "Heater runtime charge"
  },
  guest_entry: {
    name: "Private Group Entry (Per Hour)",
    description: "Guest entry charge"
  },
  manual: {
    name: "RORC Manual Billing Item",
    description: "Manual billing charge"
  }
};

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

    const alreadyInvoicedItems = openItems.filter(hasActiveStripeInvoice);
    if (alreadyInvoicedItems.length) {
      const invoiceIds = uniqueIds(alreadyInvoicedItems.map((item) => item.stripe_invoice_id).filter(Boolean));
      return res.status(409).json({
        success: false,
        error: invoiceIds.length
          ? `Selected billing items already have an active Stripe invoice: ${invoiceIds.join(", ")}. Open the existing invoice instead of creating a duplicate.`
          : "Selected billing items already have an active Stripe invoice. Open the existing invoice instead of creating a duplicate."
      });
    }

    const accountId = await accountIdForBillingItems(openItems);
    const { customerId, billingOwner } = await ensureStripeCustomerForAccount(accountId);
    const invoiceComponents = await buildInvoiceComponents(openItems);
    const invoice = await createStripeInvoice({
      accountId,
      customerId,
      billingItems: openItems,
      invoiceComponents,
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

async function createStripeInvoice({ accountId, customerId, billingItems, invoiceComponents, mode }) {
  const chargeItems = invoiceComponents.filter((item) => Number(item.amount_cents || 0) !== 0);
  if (!chargeItems.length) {
    throw httpError(400, "Stripe invoices require at least one charge greater than $0.");
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

  for (const item of chargeItems) {
    await createProductBackedInvoiceItem({
      customer: customerId,
      invoice: draft.id,
      item,
      accountId
    });
  }

  const draftWithItems = await stripe.invoices.retrieve(draft.id);
  if (Number(draftWithItems.total || 0) <= 0) {
    await stripe.invoices.voidInvoice(draft.id).catch(() => null);
    throw httpError(400, "Stripe invoice total was $0.00, so it was not sent.");
  }

  const finalized = await stripe.invoices.finalizeInvoice(draft.id);
  if (Number(finalized.total || 0) <= 0) {
    await stripe.invoices.voidInvoice(finalized.id).catch(() => null);
    throw httpError(400, "Stripe invoice total was $0.00, so it was not sent.");
  }

  if (mode === "paid") {
    return stripe.invoices.pay(finalized.id, { paid_out_of_band: true });
  }
  return stripe.invoices.sendInvoice(finalized.id);
}

async function createProductBackedInvoiceItem({ customer, invoice, item, accountId }) {
  const amountCents = Number(item.amount_cents || 0);
  const metadata = {
    rorc_billing_line_item_id: item.billing_line_item_id,
    rorc_invoice_component: item.component_key,
    rorc_account_id: accountId
  };
  const payload = {
    customer,
    invoice,
    description: item.description,
    metadata
  };

  if (amountCents > 0) {
    const price = await ensureStripePriceForComponent(item.component_key, amountCents);
    payload.pricing = { price: price.id };
    payload.quantity = 1;
  } else {
    payload.amount = amountCents;
    payload.currency = "usd";
    payload.discountable = false;
  }

  return stripe.invoiceItems.create(payload);
}

async function ensureStripePriceForComponent(componentKey, amountCents) {
  const product = await ensureStripeProductForComponent(componentKey);
  const key = normalizedStripeComponentKey(componentKey);
  const lookupKey = `rorc_${key}_${stripeIdSafeProductToken(product.id)}_${Number(amountCents || 0)}_usd`.slice(0, 200);
  const existing = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1
  });
  if (existing.data?.[0]) return existing.data[0];

  const matchingProductPrices = await stripe.prices.list({
    product: product.id,
    active: true,
    currency: "usd",
    limit: 100
  });
  const matchingPrice = (matchingProductPrices.data || []).find((price) => Number(price.unit_amount || 0) === Number(amountCents || 0));
  if (matchingPrice) return matchingPrice;

  return stripe.prices.create({
    currency: "usd",
    unit_amount: Number(amountCents || 0),
    product: product.id,
    lookup_key: lookupKey,
    nickname: `${product.name} ${formatCentsForStripeNickname(amountCents)}`,
    metadata: {
      rorc_invoice_component: key,
      rorc_managed: "true"
    }
  });
}

async function ensureStripeProductForComponent(componentKey) {
  const key = normalizedStripeComponentKey(componentKey);
  const productInfo = stripeProductInfo(componentKey);
  const existingByName = await findStripeProductByName(productInfo.name);
  if (existingByName) return existingByName;

  const productId = `rorc_${key}`.slice(0, 120);
  try {
    const existing = await stripe.products.retrieve(productId);
    if (existing && !existing.deleted) return existing;
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
  }

  try {
    return await stripe.products.create({
      id: productId,
      name: productInfo.name,
      description: productInfo.description,
      type: "service",
      metadata: {
        rorc_invoice_component: key,
        rorc_managed: "true"
      }
    });
  } catch (error) {
    if (error?.statusCode === 400 && /already exists/i.test(String(error.message || ""))) {
      return stripe.products.retrieve(productId);
    }
    throw error;
  }
}

async function findStripeProductByName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const escapedName = trimmed.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const searched = await stripe.products.search({
    query: `active:'true' AND name:'${escapedName}'`,
    limit: 1
  }).catch(() => null);
  if (searched?.data?.[0]) return searched.data[0];

  const listed = await stripe.products.list({ active: true, limit: 100 });
  return (listed.data || []).find((product) => product.name === trimmed) || null;
}

function stripeProductInfo(componentKey) {
  return STRIPE_PRODUCT_CATALOG[normalizedStripeComponentKey(componentKey)] || STRIPE_PRODUCT_CATALOG.manual;
}

function normalizedStripeComponentKey(componentKey) {
  const key = String(componentKey || "manual")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || "manual";
}

function formatCentsForStripeNickname(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function stripeIdSafeProductToken(value) {
  return String(value || "product")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "product";
}

function hasActiveStripeInvoice(item) {
  if (!item?.stripe_invoice_id) return false;
  const status = String(item.stripe_invoice_status || "").trim().toLowerCase();
  return !["void", "voided"].includes(status);
}

function invoiceItemDescription(item) {
  const reason = String(item.reason || "RORC billing item").trim();
  if (item.rental_request_id) return `Rental: ${reason}`;
  if (item.heater_use_entry_id) return `Thermostat: ${reason}`;
  if (item.timesheet_entry_id) return `Guest entry: ${reason}`;
  return reason;
}

function thermostatInvoiceDescription(item, heaterRecord = null) {
  const reason = String(item.reason || "Thermostat use").trim();
  const runtimeMinutes = durationMinutes(heaterRecord?.start_at, heaterRecord?.end_at);
  const details = [];
  if (runtimeMinutes > 0) details.push(formatBillingRuntime(runtimeMinutes));
  const timeRange = formatDateTimeRange(heaterRecord?.start_at, heaterRecord?.end_at);
  if (timeRange) details.push(timeRange);
  return details.length ? `${reason} - ${details.join(" · ")}` : `Thermostat: ${reason}`;
}

async function buildInvoiceComponents(billingItems) {
  const rentalIds = uniqueIds(billingItems.map((item) => item.rental_request_id).filter(Boolean));
  const heaterIds = uniqueIds(billingItems.map((item) => item.heater_use_entry_id).filter(Boolean));
  const rentalById = new Map();
  const heaterById = new Map();
  if (rentalIds.length) {
    const ids = rentalIds.map((id) => `"${String(id).replaceAll("\"", "")}"`).join(",");
    const rentals = await supabaseRest(`rental_requests?select=*&id=in.(${encodeURIComponent(ids)})`);
    rentals.forEach((rental) => rentalById.set(rental.id, rental));
  }
  if (heaterIds.length) {
    const ids = heaterIds.map((id) => `"${String(id).replaceAll("\"", "")}"`).join(",");
    const heaters = await supabaseRest(`heater_use_entries?select=id,system_type,start_at,end_at&id=in.(${encodeURIComponent(ids)})`);
    heaters.forEach((heater) => heaterById.set(heater.id, heater));
  }

  return billingItems.flatMap((item) => {
    if (item.rental_request_id && rentalById.has(item.rental_request_id)) {
      return rentalInvoiceComponents(item, rentalById.get(item.rental_request_id));
    }
    return [{
      billing_line_item_id: item.id,
      component_key: billingComponentKey(item, heaterById.get(item.heater_use_entry_id)),
      description: item.heater_use_entry_id
        ? thermostatInvoiceDescription(item, heaterById.get(item.heater_use_entry_id))
        : invoiceItemDescription(item),
      amount_cents: Number(item.amount_cents || 0)
    }];
  });
}

function rentalInvoiceComponents(item, rental) {
  const rows = rentalBillBreakdownRows(rental, Number(item.amount_cents || 0));
  return rows
    .filter((row) => Number(row.cents || 0) !== 0)
    .map((row) => ({
      billing_line_item_id: item.id,
      component_key: row.key,
      description: row.note ? `${row.label} - ${row.note}` : row.label,
      amount_cents: Number(row.cents || 0)
    }));
}

function rentalBillBreakdownRows(rental, rentalAmountCents) {
  const rows = [];
  const isPrivateEvent = rental?.is_private_event !== false;
  const accessHours = rentalHoursBetween(rental?.event_start_time, rental?.event_end_time, rental?.rental_hours || 1);
  const accessTimeRange = rentalAccessTimeRange(rental);
  const baseCents = rentalBaseCents(rental);
  rows.push({
    key: "rental_base",
    label: !isPrivateEvent
      ? `Non-private rental (${rentalBillableHoursLabel(accessHours)} @ $5/hr)`
      : rental?.rental_type === "hourly"
        ? `Hourly rental (${rentalHoursLabel(accessHours)} @ $10/hr)`
        : "All day rental",
    note: accessTimeRange ? `Base rental charge · ${accessTimeRange}` : "Base rental charge",
    cents: baseCents
  });

  [
    [rental?.addon_cleaning_maintenance, "maintenance", "Standard maintenance fee", RENTAL_PRICE_CENTS.cleaningMaintenance],
    [rental?.addon_tables, "tables", "Tables", RENTAL_PRICE_CENTS.tables],
    [rental?.addon_chairs, "chairs", "Chairs", RENTAL_PRICE_CENTS.chairs],
    [rental?.addon_tarp, "tarp", "Tarp", RENTAL_PRICE_CENTS.tarp],
    [rental?.addon_heater, "heater_addon", "Heater add-on", 0, "Thermostat use is billed from attached runtime"],
    [rental?.addon_ac, "ac_addon", "AC add-on", 0, "AC use is billed from attached runtime"],
    [rental?.addon_early_setup, "early_setup", "Early setup", RENTAL_PRICE_CENTS.earlySetup],
    [rental?.addon_early_day_rental, "early_day", "Extra day early", RENTAL_PRICE_CENTS.earlyDayRental],
    [rental?.addon_late_cleanup, "late_cleanup", "Late cleanup", RENTAL_PRICE_CENTS.lateCleanup],
    [rental?.addon_late_day_rental, "late_day", "Extra day late", RENTAL_PRICE_CENTS.lateDayRental]
  ].forEach(([enabled, key, label, cents, note]) => {
    if (!enabled) return;
    rows.push({ key, label, note: note || "Selected option", cents });
  });

  const subtotalBeforeDiscount = rows.reduce((sum, row) => sum + Number(row.cents || 0), 0);
  let calculatedRentalCents = subtotalBeforeDiscount;
  if (rental?.special_access_discount) {
    calculatedRentalCents = Math.round(subtotalBeforeDiscount * (1 - SPECIAL_ACCESS_RENTAL_DISCOUNT_RATE));
    rows.push({
      key: "special_access_discount",
      label: "Special Access discount",
      note: "20% off rental options",
      cents: calculatedRentalCents - subtotalBeforeDiscount
    });
  }

  const adjustmentCents = Number(rentalAmountCents || 0) - calculatedRentalCents;
  if (adjustmentCents !== 0) {
    rows.push({
      key: "rental_adjustment",
      label: "Current bill adjustment",
      note: "Difference between selected options and saved bill amount",
      cents: adjustmentCents
    });
  }

  return rows;
}

function billingComponentKey(item, heaterRecord = null) {
  if (item.rental_request_id) return "rental";
  if (item.heater_use_entry_id) {
    return String(heaterRecord?.system_type || "").trim().toLowerCase() === "ac"
      ? "ac_runtime"
      : "heater_use";
  }
  if (item.timesheet_entry_id) return "guest_entry";
  return "manual";
}

function rentalBaseCents(record) {
  const isPrivateEvent = record?.is_private_event !== false;
  if (!isPrivateEvent) {
    return Math.round(
      rentalHoursBetween(record?.event_start_time, record?.event_end_time, record?.rental_hours || 1)
      * RENTAL_PRICE_CENTS.nonPrivateHourly
    );
  }
  if (record?.rental_type === "hourly") {
    return Math.round(
      normalizeRentalHours(rentalHoursBetween(record?.event_start_time, record?.event_end_time, record?.rental_hours || 1))
      * RENTAL_PRICE_CENTS.privateHourly
    );
  }
  return RENTAL_PRICE_CENTS.allDay;
}

function rentalHoursBetween(startValue, endValue, fallback = 1) {
  const start = parseTimeMinutes(startValue);
  const end = parseTimeMinutes(endValue);
  if (start === null || end === null || end <= start) return fallback;
  return normalizeRentalBillableHours((end - start) / 60, fallback);
}

function rentalAccessTimeRange(record) {
  const start = formatTimeLabel(record?.event_start_time);
  const end = formatTimeLabel(record?.event_end_time);
  return start && end ? `${start}-${end}` : "";
}

function parseTimeMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function formatTimeLabel(value) {
  const minutes = parseTimeMinutes(value);
  if (minutes === null) return "";
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function durationMinutes(startValue, endValue) {
  const start = new Date(startValue || "");
  const end = new Date(endValue || "");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;
  return Math.round((end.getTime() - start.getTime()) / 60000);
}

function formatBillingRuntime(minutes) {
  const totalMinutes = Math.max(0, Number(minutes || 0));
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  const decimalHours = (totalMinutes / 60).toFixed(2);
  const clockText = hours > 0
    ? `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`
    : `${remainingMinutes}m`;
  return `${clockText} (${decimalHours} hrs)`;
}

function formatDateTimeRange(startValue, endValue) {
  const start = formatInvoiceDateTime(startValue);
  const end = formatInvoiceDateTime(endValue);
  if (start && end) return `${start}-${end}`;
  return start || end || "";
}

function formatInvoiceDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function normalizeRentalHours(value, fallback = 1) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(9, Math.max(0.01, Math.round(hours * 100) / 100));
}

function normalizeRentalBillableHours(value, fallback = 1) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(24, Math.max(0.01, Math.round(hours * 100) / 100));
}

function rentalHoursLabel(hours) {
  const normalized = normalizeRentalHours(hours);
  const label = String(Number(normalized.toFixed(2)));
  return `${label} hr${normalized === 1 ? "" : "s"}`;
}

function rentalBillableHoursLabel(hours) {
  const normalized = normalizeRentalBillableHours(hours);
  const label = String(Number(normalized.toFixed(2)));
  return `${label} hr${normalized === 1 ? "" : "s"}`;
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
    stripe_invoice_status: invoice.status || null,
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
    if (Object.prototype.hasOwnProperty.call(payload || {}, "stripe_invoice_status") && text.includes("stripe_invoice_status")) {
      const { stripe_invoice_status: _stripeInvoiceStatus, ...fallbackPayload } = payload;
      return updateSupabaseRows(path, fallbackPayload);
    }
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
