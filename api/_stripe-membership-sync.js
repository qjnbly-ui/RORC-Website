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

module.exports = {
  planFromSubscription,
  syncAccountMembershipPlan
};
