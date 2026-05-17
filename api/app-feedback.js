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

    const htmlBody = `
      <h2>RORC App Feedback</h2>
      <p><strong>Submitted:</strong> ${escapeHtml(submittedAt)}</p>
      <p><strong>Type:</strong> ${escapeHtml(feedbackType)}</p>
      <p><strong>Subject:</strong> ${escapeHtml(subject || "(none)")}</p>
      <p><strong>Member:</strong> ${escapeHtml(memberName || "(unknown)")}</p>
      <p><strong>Account Number:</strong> ${escapeHtml(accountNumber || "(unknown)")}</p>
      <p><strong>Member Email:</strong> ${escapeHtml(memberEmail || "(unknown)")}</p>
      <p><strong>Auth User ID:</strong> ${escapeHtml(userId || "(unknown)")}</p>
      <hr />
      <p><strong>Message</strong></p>
      <pre style="white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${escapeHtml(message)}</pre>
    `;

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
