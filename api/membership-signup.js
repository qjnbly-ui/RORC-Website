const crypto = require("crypto");
const Stripe = require("stripe");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";
const ADMIN_REVIEW_EMAIL = process.env.ADMIN_REVIEW_EMAIL || "qjnbly@hotmail.com";
const ADMIN_REVIEW_PHONE = process.env.ADMIN_REVIEW_PHONE || "5418916772";
const { sendResendEmail } = require("./_resend");
const PENDING_ACCOUNT_TYPE = "RESTRICTED ACCOUNT";
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" })
  : null;

const PLAN_CONFIG = {
  open_gym: {
    label: "Open Gym",
    accountType: "Open Gym Only",
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_OPEN_GYM_MONTHLY",
    oneTimePriceEnv: "STRIPE_PRICE_KEY_CARD"
  },
  weight_room: {
    label: "Weight Room Only",
    accountType: "Weight Room Only",
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_WEIGHT_ROOM_MONTHLY",
    oneTimePriceEnv: "STRIPE_PRICE_KEY_CARD"
  },
  full_facility: {
    label: "Full Facility",
    accountType: "Active Membership",
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_FULL_FACILITY_MONTHLY",
    oneTimePriceEnv: "STRIPE_PRICE_KEY_CARD"
  },
  full_facility_wifi: {
    label: "Full Facility + Wi-Fi",
    accountType: "Active Membership",
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_FULL_FACILITY_WIFI_MONTHLY",
    oneTimePriceEnv: "STRIPE_PRICE_KEY_CARD"
  }
};

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Supabase service role key is not configured." });
  }

  try {
    const payload = normalizeSignupPayload(req.body || {});

    if (payload.inviteToken) {
      validateSignupPayload(payload);
      return await completeAccountInvite(req, res, payload);
    }

    if (!stripe) {
      return res.status(500).json({ success: false, error: "Stripe secret key is not configured." });
    }

    const plan = PLAN_CONFIG[payload.planId];

    if (!plan) {
      return res.status(400).json({ success: false, error: "Select a valid membership plan." });
    }

    validateSignupPayload(payload);
    const checkoutPrices = await resolveCheckoutPrices(plan);
    const existingMember = await findAccountMemberByEmail(payload.primary.email);
    if (existingMember) {
      throw httpError(409, "This email is already linked to a RORC account. Use member login or a different email.");
    }
    await validateAdditionalUserEmailsAvailable(payload);

    const account = await insertSupabaseRow("accounts", {
      account_number: generateAccountNumber(),
      membership_details: plan.label,
      notes_on_account: `Online signup submitted for ${plan.label}.`,
      heater_pin: payload.primary.accessPin || null
    });

    const primaryMember = await insertSupabaseRow("account_members", {
      account_id: account.id,
      member_name: payload.primary.name,
      account_type: PENDING_ACCOUNT_TYPE,
      phone_number: payload.primary.phone || null,
      email_address: payload.primary.email || null,
      date_of_birth: payload.primary.dateOfBirth || null,
      allow_guest_entry: Boolean(payload.permissions.allowGuestEntry),
      allow_heater_use: Boolean(payload.permissions.allowHeaterUse),
      can_access_independently: payload.primary.canAccessIndependently !== false,
      is_billing_owner: true
    });

    const householdMembers = [];
    const accountInvites = [];
    for (const member of payload.householdMembers) {
      if (isUnder13(member.dateOfBirth)) {
        householdMembers.push(await insertSupabaseRow("account_members", {
          account_id: account.id,
          member_name: member.name,
          account_type: PENDING_ACCOUNT_TYPE,
          phone_number: member.phone || null,
          email_address: member.email || null,
          date_of_birth: member.dateOfBirth || null,
          guardian_member_id: primaryMember.id,
          can_access_independently: false,
          allow_guest_entry: false,
          allow_heater_use: false,
          is_billing_owner: false
        }));
        continue;
      }

      accountInvites.push(await createAccountUserInvite({
        req,
        account,
        inviterMember: primaryMember,
        member,
        accountType: plan.accountType
      }));
    }

    const customer = await stripe.customers.create({
      name: payload.primary.name,
      email: payload.primary.email,
      phone: payload.primary.phone || undefined,
      metadata: {
        rorc_account_id: account.id,
        rorc_primary_member_id: primaryMember.id,
        rorc_membership_plan: payload.planId
      }
    });

    await insertSupabaseRow("account_billing", {
      account_id: account.id,
      stripe_customer_id: customer.id,
      billing_status: "incomplete",
      last_sync: new Date().toISOString()
    });

    const contract = await insertSupabaseRow("signup_contracts", {
      account_id: account.id,
      primary_member_id: primaryMember.id,
      requested_account_number: account.account_number,
      applicant_name: payload.primary.name,
      applicant_email: payload.primary.email,
      applicant_phone: payload.primary.phone || null,
      requested_account_type: plan.accountType,
      contract_payload: {
        ...contractPayloadFromSignup(payload),
        planLabel: plan.label,
        accountNumber: account.account_number,
        householdMemberIds: householdMembers.map((member) => member.id),
        accountInviteIds: accountInvites.map((invite) => invite.id),
        invitedAccountUsers: accountInvites.map((invite) => ({
          id: invite.id,
          invitedName: invite.invitedName,
          invitedEmail: invite.invitedEmail,
          invitedPhone: invite.invitedPhone,
          sentEmail: invite.sentEmail,
          sentText: invite.sentText,
          deliveryErrors: invite.deliveryErrors
        })),
        submittedFrom: {
          ip: requestIp(req),
          userAgent: req.headers["user-agent"] || ""
        }
      },
      contract_signed_at: new Date().toISOString(),
      signup_status: "submitted"
    });

    const authUser = await createAuthUser({
      email: payload.primary.email,
      password: payload.primary.password,
      name: payload.primary.name,
      accountId: account.id,
      accountMemberId: primaryMember.id
    });

    if (authUser?.id) {
      await updateSupabaseRows(
        `account_members?id=eq.${encodeURIComponent(primaryMember.id)}`,
        { auth_user_id: authUser.id }
      );
    }

    const checkout = await createCheckoutSession({
      req,
      plan,
      payload,
      account,
      primaryMember,
      contract,
      customerId: customer.id,
      checkoutPrices
    });

    if (checkout?.id) {
      await updateSupabaseRows(
        `signup_contracts?id=eq.${encodeURIComponent(contract.id)}`,
        {
          stripe_checkout_session_id: checkout.id,
          signup_status: "awaiting_payment"
        }
      );
    }

    await sendReviewCreatedNotifications({
      req,
      contract,
      account,
      applicantName: payload.primary.name,
      applicantEmail: payload.primary.email,
      applicantPhone: payload.primary.phone,
      requestedAccountType: plan.accountType,
      sourceLabel: "New membership signup"
    }).catch((notificationError) => {
      console.warn("Review notification failed.", notificationError);
    });

    return res.status(200).json({
      success: true,
      accountId: account.id,
      memberId: primaryMember.id,
      accountNumber: account.account_number,
      invitedUsers: accountInvites.map((invite) => ({
        inviteId: invite.id,
        invitedName: invite.invitedName,
        sentEmail: invite.sentEmail,
        sentText: invite.sentText,
        deliveryErrors: invite.deliveryErrors
      })),
      stripeCustomerId: customer.id,
      checkoutUrl: checkout?.url || "",
      checkoutRequired: Boolean(checkout?.url)
    });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message || "Could not submit membership signup." });
  }
};

function normalizeSignupPayload(body) {
  const householdMembers = Array.isArray(body.householdMembers) ? body.householdMembers : [];
  return {
    inviteToken: stringValue(body.inviteToken),
    planId: stringValue(body.planId),
    primary: {
      name: stringValue(body.primary?.name),
      email: stringValue(body.primary?.email).toLowerCase(),
      phone: stringValue(body.primary?.phone),
      dateOfBirth: dateValue(body.primary?.dateOfBirth),
      address: stringValue(body.primary?.address),
      accessPin: stringValue(body.primary?.accessPin),
      password: stringValue(body.primary?.password),
      canAccessIndependently: body.primary?.canAccessIndependently !== false
    },
    householdMembers: householdMembers
      .map((member) => ({
        name: stringValue(member.name),
        email: stringValue(member.email).toLowerCase(),
        phone: stringValue(member.phone),
        dateOfBirth: dateValue(member.dateOfBirth),
        relationship: stringValue(member.relationship),
        canAccessIndependently: Boolean(member.canAccessIndependently)
      }))
      .filter((member) => member.name),
    permissions: {
      allowGuestEntry: Boolean(body.permissions?.allowGuestEntry),
      allowHeaterUse: Boolean(body.permissions?.allowHeaterUse)
    },
    acknowledgements: {
      membershipTerms: Boolean(body.acknowledgements?.membershipTerms),
      facilityAccess: Boolean(body.acknowledgements?.facilityAccess),
      photoStandards: Boolean(body.acknowledgements?.photoStandards),
      groupPayFee: Boolean(body.acknowledgements?.groupPayFee),
      heaterPenalty: Boolean(body.acknowledgements?.heaterPenalty),
      rules: Boolean(body.acknowledgements?.rules),
      liability: Boolean(body.acknowledgements?.liability),
      privacy: Boolean(body.acknowledgements?.privacy),
      termination: Boolean(body.acknowledgements?.termination),
      accountOwnerResponsibility: Boolean(body.acknowledgements?.accountOwnerResponsibility),
      miscellaneous: Boolean(body.acknowledgements?.miscellaneous)
    },
    signature: {
      typedName: stringValue(body.signature?.typedName),
      signedDate: dateValue(body.signature?.signedDate),
      questionsOrConcerns: Boolean(body.signature?.questionsOrConcerns)
    },
    contract: {
      version: stringValue(body.contract?.version) || "RORC Basic Membership Contract 2026-05-19",
      readRequired: body.contract?.readRequired !== false,
      fullContractDisplayed: Boolean(body.contract?.fullContractDisplayed),
      contractPhotosDisplayed: Boolean(body.contract?.contractPhotosDisplayed)
    }
  };
}

function validateSignupPayload(payload) {
  if (!payload.primary.name) throw httpError(400, "Primary member name is required.");
  if (!payload.primary.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.primary.email)) {
    throw httpError(400, "A valid email is required.");
  }
  if (!payload.primary.phone) throw httpError(400, "Phone number is required.");
  if (!payload.primary.dateOfBirth) throw httpError(400, "Date of birth is required.");
  if (payload.primary.accessPin && !/^\d{4}$/.test(payload.primary.accessPin)) {
    throw httpError(400, "Four digit account password must be exactly 4 numbers.");
  }
  if (!payload.primary.password || payload.primary.password.length < 8) {
    throw httpError(400, "Login password must be at least 8 characters.");
  }
  if (payload.signature.questionsOrConcerns) {
    throw httpError(400, "Questions or concerns must be resolved before accepting the contract.");
  }
  if (payload.signature.typedName.toLowerCase() !== payload.primary.name.toLowerCase()) {
    throw httpError(400, "Typed legal signature must match the primary member name.");
  }
  if (!payload.signature.signedDate) throw httpError(400, "Signed date is required.");

  const missingAck = Object.entries(payload.acknowledgements).find(([, accepted]) => !accepted);
  if (missingAck) throw httpError(400, "All contract acknowledgements are required.");
  if (!payload.contract.fullContractDisplayed || !payload.contract.contractPhotosDisplayed) {
    throw httpError(400, "Full contract review is required before signing.");
  }

  if (!payload.inviteToken && payload.householdMembers.length > 4) {
    throw httpError(400, "Accounts can have a maximum of 5 users.");
  }

  const emails = new Set([payload.primary.email].filter(Boolean));
  let over18Count = payload.primary.dateOfBirth && isAtLeast18(payload.primary.dateOfBirth) ? 1 : 0;

  for (const member of payload.householdMembers) {
    if (!member.dateOfBirth) {
      throw httpError(400, `${member.name} needs a date of birth.`);
    }

    if (member.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email)) {
      throw httpError(400, `Enter a valid email for ${member.name}.`);
    }

    if (member.email) {
      if (emails.has(member.email)) {
        throw httpError(400, `${member.name} has a duplicate email address on this signup.`);
      }
      emails.add(member.email);
    }

    if (!isUnder13(member.dateOfBirth)) {
      if (!member.email && !normalizePhone(member.phone)) {
        throw httpError(400, `${member.name} is 13 or older and needs an email or phone for the contract invite.`);
      }
    }

    if (isAtLeast18(member.dateOfBirth)) {
      over18Count += 1;
    }
  }

  if (!payload.inviteToken && over18Count > 2) {
    throw httpError(400, "Accounts can have a maximum of 2 users over 18, including pending invites.");
  }
}

function contractPayloadFromSignup(payload) {
  return {
    ...payload,
    inviteToken: undefined,
    primary: {
      ...payload.primary,
      password: undefined
    }
  };
}

async function completeAccountInvite(req, res, payload) {
  const invitation = await findPendingInvitationByToken(payload.inviteToken);
  if (!invitation) {
    throw httpError(404, "Invite link is invalid, expired, or already accepted.");
  }

  const invitedEmail = stringValue(invitation.invited_email).toLowerCase();
  if (invitedEmail && payload.primary.email !== invitedEmail) {
    throw httpError(400, "Use the email address this invite was sent to.");
  }

  if (isUnder13(payload.primary.dateOfBirth)) {
    throw httpError(400, "Users under 13 must be added by the account owner or guardian.");
  }

  const existingMember = await findAccountMemberByEmail(payload.primary.email);
  if (existingMember) {
    throw httpError(409, "This email is already linked to a RORC account. Use member login or a different email.");
  }

  const account = await getAccountById(invitation.account_id);
  if (!account) {
    throw httpError(404, "The invited account could not be found.");
  }

  const limits = await getAccountLimitStats(invitation.account_id, { excludeInvitationId: invitation.id });
  if (limits.total >= 5) {
    throw httpError(409, "This account already has the maximum of 5 users.");
  }

  if (isAtLeast18(payload.primary.dateOfBirth) && limits.over18 >= 2) {
    throw httpError(409, "This account already has the maximum of 2 users over 18.");
  }

  const member = await insertSupabaseRow("account_members", {
    account_id: invitation.account_id,
    member_name: payload.primary.name,
    account_type: PENDING_ACCOUNT_TYPE,
    phone_number: payload.primary.phone || null,
    email_address: payload.primary.email,
    date_of_birth: payload.primary.dateOfBirth,
    can_access_independently: true,
    allow_guest_entry: false,
    allow_heater_use: false,
    is_billing_owner: false
  });

  const contract = await insertSupabaseRow("signup_contracts", {
    account_id: invitation.account_id,
    primary_member_id: member.id,
    requested_account_number: account.account_number,
    applicant_name: payload.primary.name,
    applicant_email: payload.primary.email,
    applicant_phone: payload.primary.phone || null,
    requested_account_type: invitation.account_type || "Active Membership",
    contract_payload: {
      ...contractPayloadFromSignup(payload),
      invitedAccountNumber: account.account_number,
      invitationId: invitation.id,
      submittedFrom: {
        ip: requestIp(req),
        userAgent: req.headers["user-agent"] || ""
      }
    },
    contract_signed_at: new Date().toISOString(),
    signup_status: "submitted"
  });

  const authUser = await createAuthUser({
    email: payload.primary.email,
    password: payload.primary.password,
    name: payload.primary.name,
    accountId: invitation.account_id,
    accountMemberId: member.id
  });

  if (authUser?.id) {
    await updateSupabaseRows(
      `account_members?id=eq.${encodeURIComponent(member.id)}`,
      { auth_user_id: authUser.id }
    );
  }

  await updateSupabaseRows(
    `account_invitations?id=eq.${encodeURIComponent(invitation.id)}`,
    {
      invitation_status: "accepted",
      accepted_at: new Date().toISOString(),
      accepted_member_id: member.id
    }
  );

  await sendReviewCreatedNotifications({
    req,
    contract,
    account,
    applicantName: payload.primary.name,
    applicantEmail: payload.primary.email,
    applicantPhone: payload.primary.phone,
    requestedAccountType: invitation.account_type || "Active Membership",
    sourceLabel: "Account invite contract"
  }).catch((notificationError) => {
    console.warn("Review notification failed.", notificationError);
  });

  return res.status(200).json({
    success: true,
    inviteAccepted: true,
    accountId: invitation.account_id,
    memberId: member.id,
    contractId: contract.id,
    accountNumber: account.account_number,
    loginUrl: "/membership-login/?signup=pending_review"
  });
}

async function resolveCheckoutPrices(plan) {
  const priceId = process.env[plan.priceEnv];
  if (!priceId) {
    throw httpError(500, `${plan.priceEnv} is required for ${plan.label} checkout.`);
  }

  const primaryPrice = await stripe.prices.retrieve(priceId);
  const isPrimaryRecurring = Boolean(primaryPrice.recurring);
  if (plan.mode === "payment" && isPrimaryRecurring) {
    throw httpError(
      500,
      `${plan.priceEnv} must be a one-time Stripe Price for ${plan.label}. The current price is recurring, so Stripe rejects payment-mode checkout.`
    );
  }
  if (plan.mode === "subscription" && !isPrimaryRecurring) {
    throw httpError(
      500,
      `${plan.priceEnv} must be a recurring Stripe Price for ${plan.label}. The current price is one-time, so Stripe rejects subscription-mode checkout.`
    );
  }

  let oneTimePriceId = "";
  if (plan.oneTimePriceEnv) {
    const configuredOneTimePriceId = process.env[plan.oneTimePriceEnv];
    if (!configuredOneTimePriceId) {
      throw httpError(500, `${plan.oneTimePriceEnv} is required for ${plan.label} checkout.`);
    }
    const oneTimePrice = await stripe.prices.retrieve(configuredOneTimePriceId);
    if (oneTimePrice.recurring) {
      throw httpError(500, `${plan.oneTimePriceEnv} must be a one-time Stripe Price. The current price is recurring.`);
    }
    oneTimePriceId = configuredOneTimePriceId;
  }

  return { primaryPriceId: priceId, oneTimePriceId };
}

async function createCheckoutSession({ req, plan, payload, account, primaryMember, contract, customerId, checkoutPrices }) {
  if (!checkoutPrices?.primaryPriceId) {
    return null;
  }

  const lineItems = [{ price: checkoutPrices.primaryPriceId, quantity: 1 }];
  if (checkoutPrices.oneTimePriceId) {
    lineItems.push({ price: checkoutPrices.oneTimePriceId, quantity: 1 });
  }

  const metadata = {
    rorc_account_id: account.id,
    rorc_primary_member_id: primaryMember.id,
    rorc_signup_contract_id: contract.id,
    rorc_membership_plan: payload.planId
  };

  const origin = siteOrigin(req);
  const sessionParams = {
    mode: plan.mode,
    customer: customerId,
    line_items: lineItems,
    success_url: process.env.STRIPE_SIGNUP_SUCCESS_URL || `${origin}/api/membership-checkout-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: process.env.STRIPE_SIGNUP_CANCEL_URL || `${origin}/membership-signup/?signup=cancelled`,
    metadata,
    customer_update: {
      address: "auto",
      name: "auto"
    }
  };

  if (plan.mode === "subscription") {
    sessionParams.subscription_data = { metadata };
  } else {
    sessionParams.payment_intent_data = { metadata };
  }

  return stripe.checkout.sessions.create(sessionParams);
}

async function validateAdditionalUserEmailsAvailable(payload) {
  for (const member of payload.householdMembers) {
    if (!member.email) continue;
    const existingMember = await findAccountMemberByEmail(member.email);
    if (existingMember) {
      throw httpError(409, `${member.name}'s email is already linked to a RORC account.`);
    }
  }
}

async function createAccountUserInvite({ req, account, inviterMember, member, accountType }) {
  const inviteToken = crypto.randomBytes(32).toString("base64url");
  const invite = await insertSupabaseRow("account_invitations", {
    account_id: account.id,
    invited_by_member_id: inviterMember.id,
    invited_email: member.email || null,
    invited_name: member.name,
    invited_phone: member.phone || null,
    invited_date_of_birth: member.dateOfBirth,
    account_type: accountType,
    token_hash: hashToken(inviteToken),
    invitation_status: "pending",
    expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString()
  });

  const inviteUrl = `${siteOrigin(req)}/membership-signup/?invite=${encodeURIComponent(inviteToken)}`;
  const delivery = await sendInviteLink({
    email: member.email,
    phoneNumber: normalizePhone(member.phone),
    inviteUrl,
    invitedName: member.name,
    accountNumber: account.account_number || ""
  });

  return {
    id: invite.id,
    invitedName: member.name,
    invitedEmail: member.email || "",
    invitedPhone: member.phone || "",
    sentEmail: delivery.sentEmail,
    sentText: delivery.sentText,
    deliveryErrors: delivery.errors
  };
}

async function sendInviteLink({ email, phoneNumber, inviteUrl, invitedName, accountNumber }) {
  const errors = [];
  let sentEmail = false;
  let sentText = false;

  const subject = "Complete your RORC account setup";
  const message = [
    `You have been invited to join${accountNumber ? ` RORC account ${accountNumber}` : " a RORC account"}.`,
    "",
    "Complete your contract and account setup here:",
    inviteUrl,
    "",
    "This link expires in 30 days."
  ].join("\n");

  if (email) {
    if (!RESEND_API_KEY) {
      errors.push("Email was not sent because Resend is not configured.");
    } else {
      try {
        await sendInviteEmail({
          to: email,
          subject,
          text: message,
          invitedName,
          inviteUrl,
          accountNumber
        });
        sentEmail = true;
      } catch (error) {
        errors.push(`Email failed: ${error.message}`);
      }
    }
  }

  if (phoneNumber) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      errors.push("Text was not sent because Twilio is not configured.");
    } else {
      try {
        await sendTwilioText(phoneNumber, `RORC account setup link: ${inviteUrl}`);
        sentText = true;
      } catch (error) {
        errors.push(`Text failed: ${error.message}`);
      }
    }
  }

  return { sentEmail, sentText, errors };
}

async function sendInviteEmail({ to, subject, text, invitedName, inviteUrl, accountNumber }) {
  const html = buildEmailTemplate({
    title: "Complete Your RORC Account Setup",
    bodyHtml: `
      <p style="margin:0 0 14px;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">
        ${invitedName ? `Hi ${escapeHtml(invitedName)},<br />` : ""}
        You have been invited to join${accountNumber ? ` RORC account <strong>${escapeHtml(accountNumber)}</strong>` : " a RORC account"}.
      </p>
      <p style="margin:0 0 20px;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">
        Complete your contract and account setup using the secure link below.
      </p>
      <p style="margin:0 0 20px;text-align:center;">
        <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;background:#f23a36;color:#fff;text-decoration:none;border-radius:999px;padding:13px 22px;font-weight:700;">
          Complete Account Setup
        </a>
      </p>
      <p style="margin:0;color:#9ca3af;line-height:1.5;font-size:13px;text-align:center;">
        This link expires in 30 days. If the button does not work, copy this link:<br />
        <span style="word-break:break-all;">${escapeHtml(inviteUrl)}</span>
      </p>
    `
  });

  await sendResendEmail({
    apiKey: RESEND_API_KEY,
    from: RESEND_FROM_EMAIL,
    to: [to],
    subject,
    text,
    html,
    idempotencyKey: `membership-invite-${to}-${accountNumber || "account"}`
  });
}

async function sendTwilioText(to, body) {
  const auth = Buffer
    .from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)
    .toString("base64");

  const params = new URLSearchParams({
    To: to,
    From: TWILIO_FROM_NUMBER,
    Body: body
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    }
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result?.message || "Twilio request failed.");
  }
}

async function sendEmail({ to, subject, text, html }) {
  await sendResendEmail({
    apiKey: RESEND_API_KEY,
    from: RESEND_FROM_EMAIL,
    to: [to],
    subject,
    text,
    html,
    idempotencyKey: `membership-email-${to}-${subject}`
  });
}

async function sendReviewCreatedNotifications(args) {
  await Promise.all([
    sendAdminReviewEmail(args).catch((error) => {
      console.warn("Admin review email failed.", error);
    }),
    sendAdminReviewText(args).catch((error) => {
      console.warn("Admin review text failed.", error);
    }),
    sendApplicantPendingReviewNotifications(args).catch((error) => {
      console.warn("Applicant pending-review notification failed.", error);
    })
  ]);
}

async function sendAdminReviewEmail({ req, contract, account, applicantName, applicantEmail, requestedAccountType, sourceLabel }) {
  if (!RESEND_API_KEY) {
    return;
  }

  const reviewUrl = `${siteOrigin(req)}/RORC%20App/?route=contracts`;
  const subject = `[RORC Review] ${applicantName} needs approval`;
  const text = [
    `${sourceLabel} needs admin approval.`,
    "",
    `Applicant: ${applicantName}`,
    `Email: ${applicantEmail || "(none)"}`,
    `Account: ${account?.account_number || contract?.requested_account_number || "(pending)"}`,
    `Requested Type: ${requestedAccountType}`,
    `Contract ID: ${contract.id}`,
    "",
    `Review in the RORC App: ${reviewUrl}`
  ].join("\n");

  const html = buildEmailTemplate({
    title: "RORC Account Review",
    bodyHtml: `
      <p style="margin:0 0 14px;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">
        ${escapeHtml(sourceLabel)} needs admin approval.
      </p>
      <div style="margin:0 auto 20px;max-width:420px;text-align:left;color:#d1d5db;line-height:1.65;font-size:15px;">
        <p style="margin:0 0 6px;"><strong>Applicant:</strong> ${escapeHtml(applicantName)}</p>
        <p style="margin:0 0 6px;"><strong>Email:</strong> ${escapeHtml(applicantEmail || "(none)")}</p>
        <p style="margin:0 0 6px;"><strong>Account:</strong> ${escapeHtml(account?.account_number || contract?.requested_account_number || "(pending)")}</p>
        <p style="margin:0 0 6px;"><strong>Requested Type:</strong> ${escapeHtml(requestedAccountType)}</p>
      </div>
      <p style="margin:0;text-align:center;">
        <a href="${escapeHtml(reviewUrl)}" style="display:inline-block;background:#f23a36;color:#fff;text-decoration:none;border-radius:999px;padding:13px 22px;font-weight:700;">
          Open RORC App Reviews
        </a>
      </p>
    `
  });

  await sendResendEmail({
    apiKey: RESEND_API_KEY,
    from: RESEND_FROM_EMAIL,
    to: [ADMIN_REVIEW_EMAIL],
    subject,
    text,
    html,
    idempotencyKey: `admin-review-${contract.id}`
  });
}

async function sendAdminReviewText({ req, contract, account, applicantName, requestedAccountType, sourceLabel }) {
  const to = normalizePhone(ADMIN_REVIEW_PHONE);
  if (!to || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return;
  }

  const reviewUrl = `${siteOrigin(req)}/RORC%20App/?route=contracts`;
  const message = [
    `RORC review needed: ${applicantName}`,
    `${sourceLabel}`,
    `Account: ${account?.account_number || contract?.requested_account_number || "pending"}`,
    `Type: ${requestedAccountType}`,
    reviewUrl
  ].join("\n");

  await sendTwilioText(to, message);
}

async function sendApplicantPendingReviewNotifications({ req, account, applicantName, applicantEmail, applicantPhone }) {
  const loginUrl = `${siteOrigin(req)}/member-dashboard/?signup=pending_review`;
  const accountNumber = account?.account_number || "";
  const subject = "RORC account pending review";
  const text = [
    `Hi ${applicantName || "there"},`,
    "",
    "Your RORC account contract was received and is waiting for admin approval.",
    "Your dashboard may show RESTRICTED ACCOUNT until approval is complete.",
    accountNumber ? `Account: ${accountNumber}` : "",
    "",
    `Open your dashboard: ${loginUrl}`
  ].filter(Boolean).join("\n");

  if (applicantEmail && RESEND_API_KEY) {
    const html = buildEmailTemplate({
      title: "RORC Account Pending Review",
      bodyHtml: `
        <p style="margin:0 0 14px;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">
          ${applicantName ? `Hi ${escapeHtml(applicantName)},<br />` : ""}
          Your RORC account contract was received and is waiting for admin approval.
        </p>
        <p style="margin:0 0 20px;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">
          Your dashboard may show <strong>RESTRICTED ACCOUNT</strong> until approval is complete.
        </p>
        ${accountNumber ? `<p style="margin:0 0 20px;color:#d1d5db;text-align:center;"><strong>Account:</strong> ${escapeHtml(accountNumber)}</p>` : ""}
        <p style="margin:0;text-align:center;">
          <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#f23a36;color:#fff;text-decoration:none;border-radius:999px;padding:13px 22px;font-weight:700;">
            Open Dashboard
          </a>
        </p>
      `
    });

    await sendEmail({
      to: applicantEmail,
      subject,
      text,
      html
    });
  }

  const phone = normalizePhone(applicantPhone);
  if (phone && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    await sendTwilioText(
      phone,
      `RORC account received. Your dashboard may show RESTRICTED ACCOUNT until admin approval is complete. ${loginUrl}`
    );
  }
}

async function createAuthUser({ email, password, name, accountId, accountMemberId }) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: name,
        full_name: name,
        member_name: name,
        rorc_account_id: accountId,
        rorc_account_member_id: accountMemberId
      }
    })
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = String(body?.msg || body?.message || text || "");
    if (response.status === 422 && /already|registered|exists/i.test(message)) {
      throw httpError(409, "This email already has a login. Use member login or a different email.");
    }

    throw new Error(`Could not create login user: ${response.status} ${message}`);
  }

  return body;
}

async function findAccountMemberByEmail(email) {
  if (!email) return null;
  const rows = await supabaseRest(`account_members?select=id&email_address=eq.${encodeURIComponent(email)}&limit=1`);
  return rows[0] || null;
}

async function findPendingInvitationByToken(inviteToken) {
  const rows = await supabaseRest(
    `account_invitations?select=*&token_hash=eq.${encodeURIComponent(hashToken(inviteToken))}&invitation_status=eq.pending&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`
  );
  return rows[0] || null;
}

async function getAccountById(accountId) {
  const rows = await supabaseRest(`accounts?select=id,account_number&id=eq.${encodeURIComponent(accountId)}&limit=1`);
  return rows[0] || null;
}

async function getAccountLimitStats(accountId, { excludeInvitationId = "" } = {}) {
  const [members, pendingInvites] = await Promise.all([
    supabaseRest(`account_members?select=id,date_of_birth&account_id=eq.${encodeURIComponent(accountId)}&limit=100`),
    supabaseRest(`account_invitations?select=id,invited_date_of_birth&account_id=eq.${encodeURIComponent(accountId)}&invitation_status=eq.pending&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=100`)
  ]);

  const activeMembers = Array.isArray(members) ? members : [];
  const activeInvites = (Array.isArray(pendingInvites) ? pendingInvites : [])
    .filter((invite) => String(invite.id || "") !== String(excludeInvitationId || ""));

  return {
    total: activeMembers.length + activeInvites.length,
    over18: activeMembers.filter((member) => (
      member.date_of_birth ? isAtLeast18(member.date_of_birth) : true
    )).length + activeInvites.filter((invite) => isAtLeast18(invite.invited_date_of_birth)).length
  };
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

  const rows = await response.json();
  return rows[0];
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

function generateAccountNumber() {
  return `WEB-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function isUnder13(dateOfBirth) {
  const birth = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;

  const today = new Date();
  const thirteenthBirthday = new Date(Date.UTC(birth.getUTCFullYear() + 13, birth.getUTCMonth(), birth.getUTCDate()));
  return today.getTime() < thirteenthBirthday.getTime();
}

function isAtLeast18(dateOfBirth) {
  const birth = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;

  const today = new Date();
  const eighteenthBirthday = new Date(Date.UTC(birth.getUTCFullYear() + 18, birth.getUTCMonth(), birth.getUTCDate()));
  return today.getTime() >= eighteenthBirthday.getTime();
}

function normalizePhone(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function buildEmailTemplate({ title, bodyHtml }) {
  return `
    <div style="font-family:Arial,sans-serif;background:#111;color:#f5f5f5;padding:28px;line-height:1.55;text-align:center;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#1b1b1b;border:1px solid #333;border-radius:14px;overflow:hidden;text-align:center;">
        <tr>
          <td style="padding:28px 28px 16px;border-bottom:1px solid #333;text-align:center;">
            <h2 style="margin:0;color:#fff;font-size:32px;line-height:1.15;text-align:center;">${title}</h2>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px;text-align:center;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:24px 28px;border-top:1px solid #333;color:#888;font-size:13px;line-height:1.6;text-align:center;">
            <p style="margin:0 0 8px;text-align:center;">&copy; 2026 Ruth Obenchain Recreation Center</p>
            <p style="margin:0 0 8px;text-align:center;">
              <a href="https://ruthobenchainrc.com/support/" style="color:#bbb;text-decoration:none;">Support</a>
              &nbsp;|&nbsp;
              <a href="https://ruthobenchainrc.com/privacy-policy/" style="color:#bbb;text-decoration:none;">Privacy Policy</a>
              &nbsp;|&nbsp;
              <a href="https://ruthobenchainrc.com/terms-of-service/" style="color:#bbb;text-decoration:none;">Terms of Service</a>
            </p>
            <p style="margin:0;text-align:center;">Operated by Bly Community Action Team<br />Designed &amp; Built by N3XRA</p>
          </td>
        </tr>
      </table>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
}

function siteOrigin(req) {
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "https://www.ruthobenchainrc.com";
}

function stringValue(value) {
  return String(value || "").trim();
}

function dateValue(value) {
  const next = stringValue(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(next) ? next : "";
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
