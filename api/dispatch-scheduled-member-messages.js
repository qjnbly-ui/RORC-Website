const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";
const CRON_SECRET = process.env.CRON_SECRET || "";

module.exports = async (req, res) => {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  if (CRON_SECRET && bearerToken(req) !== CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    const due = await supabaseRest(
      `scheduled_member_messages?select=*&status=eq.scheduled&scheduled_for=lte.${encodeURIComponent(new Date().toISOString())}&order=scheduled_for.asc&limit=20`
    );
    const results = [];

    for (const job of due || []) {
      results.push(await dispatchScheduledMessage(job));
    }

    return res.status(200).json({
      success: true,
      processed: results.length,
      results
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Server error" });
  }
};

async function dispatchScheduledMessage(job) {
  const jobId = job?.id;
  const dispatchId = String(job?.dispatch_id || jobId || "").trim();
  const channels = job?.channels || {};
  const memberIds = Array.isArray(job?.member_ids) ? job.member_ids.map((id) => String(id || "").trim()).filter(Boolean) : [];

  try {
    await updateScheduledJob(jobId, {
      status: "processing",
      last_error: null
    });

    const members = await loadMembers(memberIds);
    const sendText = Boolean(channels.text);
    const sendEmail = Boolean(channels.email);
    const sendInApp = Boolean(channels.inApp);
    const uniquePhones = [...new Set(members.map((m) => normalizePhone(m.phone_number)).filter(Boolean))];
    const uniqueEmails = [...new Set(members.map((m) => String(m.email_address || "").trim().toLowerCase()).filter(Boolean))];

    let sentTextCount = 0;
    let sentEmailCount = 0;
    let sentInAppCount = 0;
    const errors = [];

    if (sendText) {
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        errors.push("Twilio credentials are not configured.");
      } else if (!uniquePhones.length) {
        errors.push("No selected members have phone numbers.");
      } else {
        for (const phone of uniquePhones) {
          try {
            await sendTwilioText(phone, `${job.title}\n${job.message}`);
            sentTextCount += 1;
          } catch (error) {
            errors.push(`SMS to ${phone} failed: ${error.message}`);
          }
        }
      }
    }

    if (sendEmail) {
      if (!RESEND_API_KEY) {
        errors.push("Resend API key is not configured.");
      } else if (!uniqueEmails.length) {
        errors.push("No selected members have email addresses.");
      } else {
        for (const email of uniqueEmails) {
          try {
            await sendResendEmail(email, job.title, job.message);
            sentEmailCount += 1;
          } catch (error) {
            errors.push(`Email to ${email} failed: ${error.message}`);
          }
        }
      }
    }

    try {
      await createMessageHistoryRows({
        memberIds: members.map((member) => member.id),
        title: job.title,
        message: job.message,
        createdByMemberId: job.created_by_member_id,
        channels: {
          text: sendText,
          email: sendEmail,
          inApp: sendInApp,
          dispatchHistory: true,
          dispatchId,
          recipientCount: members.length,
          sentTextCount,
          sentEmailCount,
          sentInAppCount: sendInApp ? members.length : 0,
          scheduledMessageId: jobId,
          scheduledFor: job.scheduled_for,
          scheduleLabel: job.schedule_label || "",
          rentalRequestId: job.rental_request_id || "",
          source: job.rental_request_id ? "rental" : "",
          errorMessages: errors
        }
      });
      if (sendInApp) sentInAppCount = members.length;
    } catch (error) {
      errors.push(sendInApp
        ? `In-app notifications failed: ${error.message}`
        : `Message history failed: ${error.message}`);
    }

    const delivered = sentTextCount + sentEmailCount + sentInAppCount;
    const status = delivered > 0 || !errors.length ? "sent" : "failed";
    await updateScheduledJob(jobId, {
      status,
      sent_at: status === "sent" ? new Date().toISOString() : null,
      last_error: errors.join("; ") || null
    });

    return {
      id: jobId,
      status,
      sentTextCount,
      sentEmailCount,
      sentInAppCount,
      warnings: errors
    };
  } catch (error) {
    await updateScheduledJob(jobId, {
      status: "failed",
      last_error: error.message || "Scheduled dispatch failed"
    }).catch(() => {});
    return {
      id: jobId,
      status: "failed",
      error: error.message || "Scheduled dispatch failed"
    };
  }
}

async function updateScheduledJob(id, patch) {
  if (!id) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/scheduled_member_messages?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(patch)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not update scheduled message: ${response.status} ${text}`);
  }
}

async function loadMembers(memberIds) {
  const idList = memberIds
    .map((id) => id.replace(/[^a-zA-Z0-9-_]/g, ""))
    .filter(Boolean)
    .join(",");
  if (!idList) return [];

  return supabaseRest(`account_members?select=id,member_name,phone_number,email_address&id=in.(${idList})`);
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

async function sendResendEmail(to, subject, message) {
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replaceAll("\n", "<br />");
  const html = buildEmailTemplate({
    title: safeSubject,
    bodyHtml: `<p style="margin:0;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">${safeMessage}</p>`
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
      text: message,
      html
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend request failed: ${response.status} ${errorText}`);
  }
}

async function createMessageHistoryRows({
  memberIds,
  title,
  message,
  createdByMemberId,
  channels
}) {
  const payload = memberIds.map((memberId) => ({
    recipient_member_id: memberId,
    title,
    message,
    created_by_member_id: createdByMemberId || null,
    channels: channels || {}
  }));

  const response = await fetch(`${SUPABASE_URL}/rest/v1/member_notifications`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not create notifications: ${response.status} ${text}`);
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
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
