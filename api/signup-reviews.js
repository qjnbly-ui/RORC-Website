const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";

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
      source: payload.invitationId ? "Account invite" : "New signup",
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

  if (approved) {
    const memberIds = contractMemberIds(contract);
    if (!memberIds.length) {
      throw httpError(400, "No member records are linked to this contract.");
    }

    await updateSupabaseRows(
      `account_members?id=in.(${memberIds.join(",")})`,
      { account_type: contract.requested_account_type || "Active Membership" }
    );
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

  const subject = approved ? "Your RORC account was approved" : "RORC account review update";
  const title = approved ? "RORC Account Approved" : "RORC Account Review";
  const bodyText = approved
    ? "Your RORC account has been approved. You can now use your RORC login for approved account access."
    : "Your RORC account was not approved at this time.";
  const text = [
    bodyText,
    notes ? `Notes: ${notes}` : "",
    "",
    "Open the member login: https://ruthobenchainrc.com/membership-login/"
  ].filter(Boolean).join("\n");

  const html = buildEmailTemplate({
    title: escapeHtml(title),
    bodyHtml: `
      <p style="margin:0 0 16px;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">${escapeHtml(bodyText)}</p>
      ${notes ? `<p style="margin:0 0 16px;color:#d1d5db;line-height:1.65;font-size:15px;text-align:center;"><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
      <p style="margin:0;text-align:center;">
        <a href="https://ruthobenchainrc.com/membership-login/" style="display:inline-block;background:#f23a36;color:#fff;text-decoration:none;border-radius:999px;padding:13px 22px;font-weight:700;">
          Open Member Login
        </a>
      </p>
    `
  });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [contract.applicant_email],
      subject,
      text,
      html
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend request failed: ${response.status} ${errorText}`);
  }
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
