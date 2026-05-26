const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const {
  buildRentalApplicantEmail,
  buildSignupReviewEmail
} = require("./_communication-templates");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

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
      return res.status(403).json({ success: false, error: "Only account managers can preview automated messages." });
    }

    const type = stringValue(req.body?.type);
    if (type === "signup_review") {
      const preview = await signupReviewPreview(req.body || {});
      return res.status(200).json({ success: true, preview });
    }

    if (type === "rental_review") {
      const preview = await rentalReviewPreview(req, req.body || {});
      return res.status(200).json({ success: true, preview });
    }

    return res.status(400).json({ success: false, error: "Unsupported preview type." });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message || "Could not build preview." });
  }
};

async function signupReviewPreview(body) {
  const contractId = stringValue(body.contractId);
  const action = stringValue(body.action).toLowerCase();
  const notes = stringValue(body.notes);

  if (!contractId) {
    throw httpError(400, "Missing contract ID.");
  }
  if (!["approve", "reject"].includes(action)) {
    throw httpError(400, "Action must be approve or reject.");
  }

  const rows = await supabaseRest(`signup_contracts?select=*&id=eq.${encodeURIComponent(contractId)}&limit=1`);
  const contract = rows[0];
  if (!contract) {
    throw httpError(404, "Contract review was not found.");
  }

  return previewPayload(buildSignupReviewEmail({
    contract,
    approved: action === "approve",
    notes
  }));
}

async function rentalReviewPreview(req, body) {
  const id = stringValue(body.id);
  const notes = stringValue(body.adminNotes ?? body.notes);
  const statusMap = {
    confirm: "confirmed",
    confirmed: "confirmed",
    decline: "rejected",
    rejected: "rejected",
    cancel: "canceled",
    canceled: "canceled"
  };
  const status = statusMap[stringValue(body.status || body.action).toLowerCase()];

  if (!id) {
    throw httpError(400, "Missing rental request ID.");
  }
  if (!status) {
    throw httpError(400, "Rental preview requires confirm, decline, or cancel.");
  }

  const rows = await supabaseRest(`rental_requests?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  const record = rows[0];
  if (!record) {
    throw httpError(404, "Rental request was not found.");
  }

  return previewPayload(buildRentalApplicantEmail({
    record,
    status,
    adminNotes: notes,
    manageUrl: rentalManagePreviewUrl(req, record, status)
  }));
}

function rentalManagePreviewUrl(req, record, status) {
  if (status !== "confirmed") return "";
  if (record?.claimed_member_id) {
    return `${siteOrigin(req)}/member-dashboard/?booking=${encodeURIComponent(record.booking_number || record.id)}`;
  }
  return `${siteOrigin(req)}/rental-account/?token=secure-link-created-when-confirmed`;
}

function previewPayload(email) {
  const to = stringValue(email.to);
  const willSend = Boolean(RESEND_API_KEY && to);
  return {
    channel: "email",
    to,
    subject: email.subject,
    text: email.text,
    html: email.html,
    willSend,
    deliveryLabel: willSend
      ? "Email will be sent"
      : to ? "Email preview only; Resend is not configured." : "No email address is on file."
  };
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
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

function stringValue(value) {
  return String(value || "").trim();
}

function siteOrigin(req) {
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/+$/, "");
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "https://ruthobenchainrc.com";
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
