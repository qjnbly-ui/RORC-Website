const MEMBERSHIP_PRICE_PLANS = [
  {
    priceEnv: "STRIPE_PRICE_FULL_FACILITY_WIFI_MONTHLY",
    label: "Full Facility + Wi-Fi",
    accountType: "Active Membership"
  },
  {
    priceEnv: "STRIPE_PRICE_FULL_FACILITY_MONTHLY",
    label: "Full Facility",
    accountType: "Active Membership"
  },
  {
    priceEnv: "STRIPE_PRICE_WEIGHT_ROOM_MONTHLY",
    label: "Weight Room Only",
    accountType: "Weight Room Only"
  },
  {
    priceEnv: "STRIPE_PRICE_OPEN_GYM_MONTHLY",
    label: "Open Gym",
    accountType: "Open Gym Only"
  }
];

const MEMBERSHIP_MANAGED_ACCOUNT_TYPES = new Set([
  "Active Membership",
  "Weight Room Only",
  "Open Gym Only",
  "Account Past Due NO ACCESS ALLOWED"
]);

function planFromSubscription(subscription) {
  const subscriptionPriceIds = new Set(
    (subscription?.items?.data || [])
      .map((item) => item?.price?.id)
      .filter(Boolean)
  );

  return MEMBERSHIP_PRICE_PLANS
    .map((plan) => ({
      ...plan,
      priceId: process.env[plan.priceEnv] || ""
    }))
    .find((plan) => plan.priceId && subscriptionPriceIds.has(plan.priceId)) || null;
}

async function syncAccountMembershipPlan({ accountId, subscription, hasUnpaidBalance = false, supabaseRest, updateSupabaseRows }) {
  const paidPlan = planFromSubscription(subscription);
  const status = String(subscription?.status || "");
  const plan = status === "canceled" && paidPlan && !hasUnpaidBalance
    ? { ...paidPlan, label: "Open Gym", accountType: "Open Gym Only" }
    : (hasUnpaidBalance || ["past_due", "unpaid", "paused", "incomplete", "incomplete_expired"].includes(status)) && paidPlan
      ? { ...paidPlan, accountType: "Account Past Due NO ACCESS ALLOWED" }
      : paidPlan;

  if (!accountId || !plan) {
    return {
      synced: false,
      plan: null,
      updatedMemberCount: 0
    };
  }

  await updateSupabaseRows(
    `accounts?id=eq.${encodeURIComponent(accountId)}`,
    { membership_details: plan.label }
  );

  const accountMembers = await supabaseRest(
    `account_members?select=id,account_type&account_id=eq.${encodeURIComponent(accountId)}`
  );
  const memberIdsToUpdate = accountMembers
    .filter((member) => MEMBERSHIP_MANAGED_ACCOUNT_TYPES.has(member.account_type))
    .filter((member) => member.account_type !== plan.accountType)
    .map((member) => member.id);

  if (memberIdsToUpdate.length) {
    await updateSupabaseRows(
      `account_members?id=in.(${memberIdsToUpdate.join(",")})`,
      { account_type: plan.accountType }
    );
  }

  return {
    synced: true,
    plan: {
      label: plan.label,
      accountType: plan.accountType,
      priceId: plan.priceId
    },
    updatedMemberCount: memberIdsToUpdate.length
  };
}

async function canceledMembershipHasDebt({ accountId, subscription, paymentReceived = false, stripe, supabaseRest }) {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!customerId) throw new Error("Cannot verify canceled membership balance without a Stripe customer.");
  // Cancellation stops billing, but does not settle an outstanding invoice.
  for await (const invoice of stripe.invoices.list({ customer: customerId, limit: 100 })) {
    if (["open", "uncollectible"].includes(invoice.status) && Number(invoice.amount_remaining || 0) > 0) return true;
  }
  const members = await supabaseRest(`account_members?select=id&account_id=eq.${encodeURIComponent(accountId)}`);
  if (members.length) {
    const charges = await supabaseRest(`billing_line_items?select=amount_cents,payment_recorded_at,posted_to_stripe_at,stripe_invoice_id,stripe_invoice_status&account_member_id=in.(${members.map(m => m.id).join(",")})`);
    if (charges.some(row => Number(row.amount_cents) > 0 && (row.stripe_invoice_id
      ? ["open", "uncollectible"].includes(row.stripe_invoice_status)
      : !row.payment_recorded_at && !row.posted_to_stripe_at))) return true;
  }
  const billing = await supabaseRest(`account_billing?select=billing_status&account_id=eq.${encodeURIComponent(accountId)}&limit=1`);
  // Keep the past-due hold through cancellation and void events. Only an actual
  // payment can release it after all remaining balances have been checked.
  return !paymentReceived && (billing[0]?.billing_status === "past_due"
    || subscription.cancellation_details?.reason === "payment_failed");
}

module.exports = {
  planFromSubscription,
  canceledMembershipHasDebt,
  syncAccountMembershipPlan
};
