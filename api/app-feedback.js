const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";
const FEEDBACK_TO_EMAIL = "quentin.nichols@ruthobenchainrc.com";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      success: false,
      error: "Supabase service role key is not configured"
    });
  }

  if (!RESEND_API_KEY) {
    return res.status(500).json({
      success: false,
      error: "Resend API key is not configured"
    });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Missing Supabase session"
      });
    }

    const user = await getSupabaseUser(token);
    const payload = req.body || {};
    const feedbackType = String(payload.feedbackType || "General").trim();
    const subject = String(payload.subject || "").trim();
    const message = String(payload.message || "").trim();
    const accountNumber = String(payload.accountNumber || "").trim();
    const memberName = String(payload.memberName || "").trim();

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Feedback message is required"
      });
    }

    const emailSubject = `[RORC App Feedback] ${feedbackType}${subject ? ` - ${subject}` : ""}`;
    const submittedAt = new Date().toISOString();
    const memberEmail = String(user?.email || "").trim();
    const userId = String(user?.id || "").trim();

    const textBody = [
      "RORC App Feedback",
      `Submitted: ${submittedAt}`,
      `Type: ${feedbackType}`,
      `Subject: ${subject || "(none)"}`,
      `Member: ${memberName || "(unknown)"}`,
      `Account Number: ${accountNumber || "(unknown)"}`,
      `Member Email: ${memberEmail || "(unknown)"}`,
      `Auth User ID: ${userId || "(unknown)"}`,
      "",
      "Message:",
      message
    ].join("\n");

    const htmlBody = buildEmailTemplate({
      title: "RORC App Feedback",
      bodyHtml: `
        <p style="margin:0 0 8px;color:#d1d5db;"><strong>Submitted:</strong> ${escapeHtml(submittedAt)}</p>
        <p style="margin:0 0 8px;color:#d1d5db;"><strong>Type:</strong> ${escapeHtml(feedbackType)}</p>
        <p style="margin:0 0 8px;color:#d1d5db;"><strong>Subject:</strong> ${escapeHtml(subject || "(none)")}</p>
        <p style="margin:0 0 8px;color:#d1d5db;"><strong>Member:</strong> ${escapeHtml(memberName || "(unknown)")}</p>
        <p style="margin:0 0 8px;color:#d1d5db;"><strong>Account Number:</strong> ${escapeHtml(accountNumber || "(unknown)")}</p>
        <p style="margin:0 0 8px;color:#d1d5db;"><strong>Member Email:</strong> ${escapeHtml(memberEmail || "(unknown)")}</p>
        <p style="margin:0 0 14px;color:#d1d5db;"><strong>Auth User ID:</strong> ${escapeHtml(userId || "(unknown)")}</p>
        <p style="margin:0 0 6px;color:#f8fafc;"><strong>Message</strong></p>
        <div style="white-space:pre-wrap;color:#d1d5db;line-height:1.6;">${escapeHtml(message)}</div>
      `
    });

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [FEEDBACK_TO_EMAIL],
        reply_to: memberEmail ? [memberEmail] : undefined,
        subject: emailSubject,
        text: textBody,
        html: htmlBody
      })
    });

    if (!resendResponse.ok) {
      const resendError = await resendResponse.text();
      throw new Error(`Resend error: ${resendResponse.status} ${resendError}`);
    }

    return res.status(200).json({
      success: true
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
};

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
    throw new Error("Invalid Supabase session");
  }

  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildEmailTemplate({ title, bodyHtml }) {
  return `
    <div style="background:#0f1115;padding:24px 12px;font-family:Arial,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#171a21;border:1px solid #2c3340;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:22px 24px;border-bottom:1px solid #2c3340;">
            <h1 style="margin:0;color:#f8fafc;font-size:26px;line-height:1.1;">${escapeHtml(title)}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 24px;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:18px 24px;border-top:1px solid #2c3340;color:#9ca3af;font-size:13px;line-height:1.6;">
            <p style="margin:0 0 8px;">&copy; 2026 Ruth Obenchain Recreation Center</p>
            <p style="margin:0 0 8px;">
              <a href="https://ruthobenchainrc.com/support/" style="color:#cbd5e1;text-decoration:none;">Support</a>
              &nbsp;|&nbsp;
              <a href="https://ruthobenchainrc.com/privacy-policy/" style="color:#cbd5e1;text-decoration:none;">Privacy Policy</a>
              &nbsp;|&nbsp;
              <a href="https://ruthobenchainrc.com/terms-of-service/" style="color:#cbd5e1;text-decoration:none;">Terms of Service</a>
            </p>
            <p style="margin:0;">Operated by Bly Community Action Team<br />Designed &amp; Built by N3XRA</p>
          </td>
        </tr>
      </table>
    </div>
  `;
}
