const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";
const { buildSignupReviewEmail } = require("./_communication-templates");
const { sendResendEmail } = require("./_resend");

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured." });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token." });
    }

    const user = await getSupabaseUser(token);
    const manager = await getAccountMemberByAuthUserId(user.id);
    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Only account managers can review contracts." });
    }

    if (req.method === "GET") {
      const reviews = await loadSignupReviews();
      return res.status(200).json({ success: true, reviews });
    }

    if (req.method === "POST") {
      const contractId = stringValue(req.body?.contractId);
      const action = stringValue(req.body?.action).toLowerCase();
      const notes = stringValue(req.body?.notes);

      if (!contractId) {
        return res.status(400).json({ success: false, error: "Missing contract ID." });
      }

      if (!["approve", "reject"].includes(action)) {
        return res.status(400).json({ success: false, error: "Action must be approve or reject." });
      }

      const review = await reviewSignupContract({ contractId, action, notes, manager });
      return res.status(200).json({ success: true, review });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message || "Could not load signup reviews." });
  }
};

async function loadSignupReviews() {
  const rows = await supabaseRest(
    "signup_contracts?select=id,account_id,primary_member_id,requested_account_number,applicant_name,applicant_email,applicant_phone,requested_account_type,signup_status,contract_payload,contract_signed_at,admin_review_status,admin_reviewed_at,admin_review_notes,created_at,updated_at&order=created_at.desc&limit=200"
  );

  const accountIds = unique(rows.map((row) => row.account_id).filter(Boolean));
  const memberIds = unique(rows.map((row) => row.primary_member_id).filter(Boolean));

  const [accounts, billingRows, primaryMembers] = await Promise.all([
    accountIds.length ? supabaseRest(`accounts?select=id,account_number,membership_details&id=in.(${accountIds.join(",")})`) : [],
    accountIds.length ? supabaseRest(`account_billing?select=account_id,billing_status,stripe_status,current_period_end,last_sync&account_id=in.(${accountIds.join(",")})`) : [],
    memberIds.length ? supabaseRest(`account_members?select=id,member_name,account_type,email_address,phone_number,date_of_birth&id=in.(${memberIds.join(",")})`) : []
  ]);

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const billingByAccountId = new Map(billingRows.map((row) => [row.account_id, row]));
  const memberById = new Map(primaryMembers.map((member) => [member.id, member]));

  return rows.map((row) => {
    const account = accountById.get(row.account_id) || {};
    const billing = billingByAccountId.get(row.account_id) || {};
    const member = memberById.get(row.primary_member_id) || {};
    const payload = row.contract_payload || {};

    return {
      id: row.id,
      accountId: row.account_id,
      primaryMemberId: row.primary_member_id,
      accountNumber: account.account_number || row.requested_account_number || "",
      applicantName: row.applicant_name || member.member_name || "",
      applicantEmail: row.applicant_email || member.email_address || "",
      applicantPhone: row.applicant_phone || member.phone_number || "",
      requestedAccountType: row.requested_account_type || "",
      currentAccountType: member.account_type || "",
      signupStatus: row.signup_status || "",
      adminReviewStatus: row.admin_review_status || "pending",
      adminReviewedAt: row.admin_reviewed_at || "",
      adminReviewNotes: row.admin_review_notes || "",
      contractSignedAt: row.contract_signed_at || "",
      createdAt: row.created_at || "",
      billingStatus: billing.billing_status || billing.stripe_status || "none",
      currentPeriodEnd: billing.current_period_end || "",
      source: payload.upgradeFromRental ? "Rental account upgrade" : payload.invitationId ? "Account invite" : "New signup",
      planLabel: payload.planLabel || account.membership_details || "",
      householdCount: Array.isArray(payload.householdMemberIds) ? payload.householdMemberIds.length : 0
    };
  });
}

async function reviewSignupContract({ contractId, action, notes, manager }) {
  const rows = await supabaseRest(`signup_contracts?select=*&id=eq.${encodeURIComponent(contractId)}&limit=1`);
  const contract = rows[0];
  if (!contract) {
    throw httpError(404, "Contract review was not found.");
  }

  if (contract.admin_review_status && contract.admin_review_status !== "pending") {
    throw httpError(409, "This contract has already been reviewed.");
  }

  const now = new Date().toISOString();
  const approved = action === "approve";
  const payload = contract.contract_payload || {};

  if (approved) {
    const memberIds = contractMemberIds(contract);
    if (!memberIds.length) {
      throw httpError(400, "No member records are linked to this contract.");
    }

    await updateSupabaseRows(
      `account_members?id=in.(${memberIds.join(",")})`,
      { account_type: contract.requested_account_type || "Active Membership" }
    );

    if (payload.upgradeFromRental && payload.planLabel) {
      await updateSupabaseRows(
        `accounts?id=eq.${encodeURIComponent(contract.account_id)}`,
        { membership_details: payload.planLabel }
      ).catch((error) => console.warn("Could not update upgraded account details.", error));
    }
  } else if (payload.upgradeFromRental) {
    await updateSupabaseRows(
      `accounts?id=eq.${encodeURIComponent(contract.account_id)}`,
      { membership_details: "Rental Account" }
    ).catch((error) => console.warn("Could not restore rental account details.", error));
  }

  const reviewPatch = {
    admin_review_status: approved ? "approved" : "rejected",
    admin_reviewed_at: now,
    admin_reviewed_by_member_id: manager.id,
    admin_review_notes: notes || null,
    signup_status: approved ? "active" : "rejected"
  };

  await updateSupabaseRows(`signup_contracts?id=eq.${encodeURIComponent(contract.id)}`, reviewPatch);

  await sendApplicantReviewEmail({ contract, approved, notes }).catch((emailError) => {
    console.warn("Applicant review email failed.", emailError);
  });

  return {
    id: contract.id,
    adminReviewStatus: reviewPatch.admin_review_status,
    adminReviewedAt: now
  };
}

function contractMemberIds(contract) {
  const payload = contract.contract_payload || {};
  return unique([
    contract.primary_member_id,
    ...(Array.isArray(payload.householdMemberIds) ? payload.householdMemberIds : [])
  ].filter(Boolean));
}

async function sendApplicantReviewEmail({ contract, approved, notes }) {
  if (!RESEND_API_KEY || !contract.applicant_email) return;

  const email = buildSignupReviewEmail({ contract, approved, notes });

  await sendResendEmail({
    apiKey: RESEND_API_KEY,
    from: RESEND_FROM_EMAIL,
    to: [contract.applicant_email],
    subject: email.subject,
    text: email.text,
    html: email.html,
    idempotencyKey: `signup-review-${contract.id}-${approved ? "approved" : "rejected"}`
  });
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

  if (!response.ok) {
    throw httpError(401, "Invalid session.");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
}

async function supabaseRest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: supabaseHeaders()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST request failed: ${response.status} ${text}`);
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

function supabaseHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function stringValue(value) {
  return String(value || "").trim();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
