const crypto = require("crypto");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured." });
  }

  try {
    if (req.method === "GET") {
      return handleInvitationLookup(req, res);
    }

    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }

    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token." });
    }

    const user = await getSupabaseUser(token);
    const actor = await getAccountMemberByAuthUserId(user.id);
    if (!actor) {
      return res.status(403).json({ success: false, error: "No linked member profile found." });
    }

    if (actor.account_type !== "Account Manager" && !actor.is_billing_owner) {
      return res.status(403).json({ success: false, error: "Only account managers or billing owners can invite account users." });
    }

    const email = stringValue(req.body?.email).toLowerCase();
    const memberName = stringValue(req.body?.memberName) || email;
    const phoneNumber = stringValue(req.body?.phoneNumber);
    const normalizedPhone = normalizePhone(phoneNumber);
    const dateOfBirth = dateValue(req.body?.dateOfBirth);

    if (!dateOfBirth) {
      return res.status(400).json({ success: false, error: "Date of birth is required." });
    }

    if (!memberName) {
      return res.status(400).json({ success: false, error: "Name is required." });
    }

    const under13 = isUnder13(dateOfBirth);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: "Enter a valid email address." });
    }

    if (!under13 && !email && !normalizedPhone) {
      return res.status(400).json({ success: false, error: "Email or a valid phone number is required for anyone 13 or older." });
    }

    if (email) {
      const existingMember = await findAccountMemberByEmail(actor.account_id, email);
      if (existingMember) {
        return res.status(409).json({ success: false, error: "That email is already on this account." });
      }

      const existingEmail = await findAnyAccountMemberByEmail(email);
      if (existingEmail) {
        return res.status(409).json({ success: false, error: "That email is already linked to another RORC account." });
      }
    }

    const accountType = invitedAccountType(actor.account_type);
    const limits = await getAccountLimitStats(actor.account_id);
    const over18 = isAtLeast18(dateOfBirth);

    if (limits.total >= 5) {
      return res.status(409).json({ success: false, error: "This account already has the maximum of 5 users, including pending invites." });
    }

    if (over18 && limits.over18 >= 2) {
      return res.status(409).json({ success: false, error: "This account already has the maximum of 2 users over 18, including pending invites." });
    }

    if (under13) {
      const member = await insertSupabaseRow("account_members", {
        account_id: actor.account_id,
        member_name: memberName,
        account_type: accountType,
        phone_number: phoneNumber || null,
        email_address: email || null,
        date_of_birth: dateOfBirth,
        guardian_member_id: actor.id,
        can_access_independently: false,
        allow_guest_entry: false,
        allow_heater_use: false,
        is_billing_owner: false
      });

      return res.status(200).json({
        success: true,
        memberId: member.id,
        under13: true,
        message: "Under-13 user added to your account. They do not receive separate login access or sign their own contract."
      });
    }

    const existingInvite = email ? await findPendingInvitationByEmail(actor.account_id, email) : null;
    if (existingInvite) {
      return res.status(409).json({ success: false, error: "A pending contract invite already exists for that email." });
    }

    const inviteToken = crypto.randomBytes(32).toString("base64url");
    const invite = await insertSupabaseRow("account_invitations", {
      account_id: actor.account_id,
      invited_by_member_id: actor.id,
      invited_email: email,
      invited_name: memberName,
      invited_phone: phoneNumber || null,
      invited_date_of_birth: dateOfBirth,
      account_type: accountType,
      token_hash: hashToken(inviteToken),
      invitation_status: "pending",
      expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString()
    });

    const inviteUrl = `${siteOrigin(req)}/membership-signup/?invite=${encodeURIComponent(inviteToken)}`;
    const account = await getAccountById(actor.account_id);
    const delivery = await sendInviteLink({
      email,
      phoneNumber: normalizedPhone,
      inviteUrl,
      invitedName: memberName,
      accountNumber: account?.account_number || ""
    });

    return res.status(200).json({
      success: true,
      inviteId: invite.id,
      inviteUrl,
      sentEmail: delivery.sentEmail,
      sentText: delivery.sentText,
      deliveryErrors: delivery.errors,
      message: inviteDeliveryMessage(delivery)
    });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message || "Could not invite account user." });
  }
};

async function handleInvitationLookup(req, res) {
  const inviteToken = queryValue(req, "token");
  if (!inviteToken) {
    return res.status(400).json({ success: false, error: "Missing invite token." });
  }

  const invite = await findPendingInvitationByToken(inviteToken);
  if (!invite) {
    return res.status(404).json({ success: false, error: "Invite link is invalid, expired, or already accepted." });
  }

  const account = await getAccountById(invite.account_id);

  return res.status(200).json({
    success: true,
    invitation: {
      accountNumber: account?.account_number || "",
      accountType: invite.account_type,
      email: invite.invited_email || "",
      name: invite.invited_name || "",
      phone: invite.invited_phone || "",
      dateOfBirth: invite.invited_date_of_birth || "",
      expiresAt: invite.expires_at
    }
  });
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function queryValue(req, key) {
  if (req.query && req.query[key]) return String(req.query[key]);
  const parsed = new URL(req.url || "", "https://rorc.local");
  return String(parsed.searchParams.get(key) || "");
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
  const rows = await supabaseRest(`account_members?select=id,account_id,account_type,is_billing_owner&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
}

async function getAccountById(accountId) {
  const rows = await supabaseRest(`accounts?select=id,account_number&id=eq.${encodeURIComponent(accountId)}&limit=1`);
  return rows[0] || null;
}

async function findAccountMemberByEmail(accountId, email) {
  const rows = await supabaseRest(
    `account_members?select=id&account_id=eq.${encodeURIComponent(accountId)}&email_address=eq.${encodeURIComponent(email)}&limit=1`
  );
  return rows[0] || null;
}

async function findAnyAccountMemberByEmail(email) {
  const rows = await supabaseRest(`account_members?select=id&email_address=eq.${encodeURIComponent(email)}&limit=1`);
  return rows[0] || null;
}

async function findPendingInvitationByEmail(accountId, email) {
  const rows = await supabaseRest(
    `account_invitations?select=id&account_id=eq.${encodeURIComponent(accountId)}&invited_email=eq.${encodeURIComponent(email)}&invitation_status=eq.pending&limit=1`
  );
  return rows[0] || null;
}

async function findPendingInvitationByToken(inviteToken) {
  const rows = await supabaseRest(
    `account_invitations?select=*&token_hash=eq.${encodeURIComponent(hashToken(inviteToken))}&invitation_status=eq.pending&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`
  );
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

function supabaseHeaders({ prefer = "" } = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {})
  };
}

function invitedAccountType(accountType) {
  return accountType === "Account Manager" ? "Active Membership" : accountType;
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
        await sendResendEmail({
          to: email,
          subject,
          text: message,
          title: "Complete Your RORC Account Setup",
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

function inviteDeliveryMessage(delivery) {
  const channels = [
    delivery.sentEmail ? "email" : "",
    delivery.sentText ? "text" : ""
  ].filter(Boolean);

  if (channels.length) {
    return `Contract invite sent by ${channels.join(" and ")}.`;
  }

  return "Contract invite created. Automatic delivery did not send, so copy and send the link manually.";
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

async function sendResendEmail({ to, subject, text, title, invitedName, inviteUrl, accountNumber }) {
  const html = buildEmailTemplate({
    title: escapeHtml(title),
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

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [to],
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
