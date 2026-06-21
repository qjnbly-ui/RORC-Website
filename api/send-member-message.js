const crypto = require("crypto");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";
const FACILITY_TIME_ZONE = "America/Los_Angeles";
const { sendResendBatchEmails } = require("./_resend");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token" });
    }

    const user = await getSupabaseUser(token);
    const manager = await getAccountMemberByAuthUserId(user.id);
    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Only account managers can send messages." });
    }

    const title = String(req.body?.title || "").trim();
    const message = String(req.body?.message || "").trim();
    const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map((v) => String(v || "").trim()).filter(Boolean) : [];
    const sendText = Boolean(req.body?.channels?.text);
    const sendEmail = Boolean(req.body?.channels?.email);
    const sendInApp = Boolean(req.body?.channels?.inApp);
    const requestedSendAt = String(req.body?.sendAt || "").trim();
    const dispatchId = crypto.randomUUID();

    if (!title) {
      return res.status(400).json({ success: false, error: "Title is required." });
    }
    if (!message) {
      return res.status(400).json({ success: false, error: "Message is required." });
    }
    if (!memberIds.length) {
      return res.status(400).json({ success: false, error: "Select at least one member." });
    }
    if (!sendText && !sendEmail && !sendInApp) {
      return res.status(400).json({ success: false, error: "Select at least one delivery channel." });
    }

    const members = await loadMembers(memberIds);
    if (!members.length) {
      return res.status(404).json({ success: false, error: "No members found for selection." });
    }

    const scheduledFor = futureSendAtIso(requestedSendAt);
    if (scheduledFor) {
      const scheduledMessage = await createScheduledMemberMessage({
        createdByMemberId: manager.id,
        rentalRequestId: String(req.body?.rentalRequestId || "").trim() || null,
        title,
        message,
        memberIds: members.map((member) => member.id),
        channels: {
          text: sendText,
          email: sendEmail,
          inApp: sendInApp
        },
        scheduledFor,
        scheduleLabel: String(req.body?.scheduleLabel || "").trim() || null,
        dispatchId
      });

      await createMessageHistoryRows({
        memberIds: [manager.id],
        title,
        message,
        createdByMemberId: manager.id,
        channels: {
          text: sendText,
          email: sendEmail,
          inApp: sendInApp,
          dispatchHistory: true,
          dispatchId,
          recipientCount: members.length,
          sentTextCount: 0,
          sentEmailCount: 0,
          sentInAppCount: 0,
          requestedSendAt,
          scheduled: true,
          scheduledFor,
          scheduledMessageId: scheduledMessage.id || "",
          scheduledStatus: "scheduled",
          scheduleLabel: String(req.body?.scheduleLabel || "").trim() || "",
          rentalRequestId: String(req.body?.rentalRequestId || "").trim() || "",
          source: String(req.body?.source || "").trim() || "",
          errorMessages: []
        }
      });

      return res.status(200).json({
        success: true,
        scheduled: true,
        scheduledFor,
        sentTextCount: 0,
        sentEmailCount: 0,
        sentInAppCount: 0,
        scheduledMessageId: scheduledMessage.id || "",
        historyRecord: {
          id: dispatchId,
          dispatchId,
          scheduledMessageId: scheduledMessage.id || "",
          scheduledStatus: "scheduled",
          title,
          message,
          channels: {
            text: sendText,
            email: sendEmail,
            inApp: sendInApp,
            scheduled: true,
            scheduledFor,
            scheduledMessageId: scheduledMessage.id || "",
            scheduledStatus: "scheduled",
            scheduleLabel: String(req.body?.scheduleLabel || "").trim() || ""
          },
          recipientCount: members.length,
          sentTextCount: 0,
          sentEmailCount: 0,
          sentInAppCount: 0,
          warnings: [],
          createdAt: new Date().toISOString()
        },
        warnings: []
      });
    }

    const uniquePhones = [...new Set(members.map((m) => normalizePhone(m.phone_number)).filter(Boolean))];
    const emailRecipients = collectEmailRecipients(members);

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
            await sendTwilioText(phone, buildTextMessageBody(title, message));
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
      } else if (!emailRecipients.valid.length) {
        if (emailRecipients.invalid.length) {
          errors.push(`Skipped invalid email ${emailRecipients.invalid.length === 1 ? "address" : "addresses"} for ${formatInvalidEmailMembers(emailRecipients.invalid)}.`);
        }
        errors.push("No selected members have valid email addresses.");
      } else {
        if (emailRecipients.invalid.length) {
          errors.push(`Skipped invalid email ${emailRecipients.invalid.length === 1 ? "address" : "addresses"} for ${formatInvalidEmailMembers(emailRecipients.invalid)}.`);
        }
        try {
          const result = await sendResendBatchEmails({
            apiKey: RESEND_API_KEY,
            emails: buildMemberMessageEmails(emailRecipients.valid, title, message),
            idempotencyKeyPrefix: `member-message-${dispatchId}`
          });
          sentEmailCount += result.sentCount;
        } catch (error) {
          errors.push(`Email batch failed: ${error.message}`);
        }
      }
    }

    try {
      await createMessageHistoryRows({
        memberIds: members.map((member) => member.id),
        title,
        message,
        createdByMemberId: manager.id,
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
          requestedSendAt,
          errorMessages: errors
        }
      });
      if (sendInApp) {
        sentInAppCount = members.length;
      }
    } catch (error) {
      errors.push(sendInApp
        ? `In-app notifications failed: ${error.message}`
        : `Message history failed: ${error.message}`);
    }

    if (errors.length && sentTextCount === 0 && sentEmailCount === 0 && sentInAppCount === 0) {
      return res.status(500).json({ success: false, error: errors[0] });
    }

    return res.status(200).json({
      success: true,
      sentTextCount,
      sentEmailCount,
      sentInAppCount,
      historyRecord: {
        id: dispatchId,
        title,
        message,
        channels: {
          text: sendText,
          email: sendEmail,
          inApp: sendInApp
        },
        recipientCount: members.length,
        sentTextCount,
        sentEmailCount,
        sentInAppCount,
        warnings: errors,
        createdAt: new Date().toISOString()
      },
      warnings: errors
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Server error" });
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
    throw new Error("Invalid session");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
}

function futureSendAtIso(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new Date(parseSendAtValue(raw));
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.getTime() > Date.now() + 60000 ? parsed.toISOString() : "";
}

function parseSendAtValue(value) {
  const raw = String(value || "").trim();
  const localMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/);
  if (localMatch) {
    return facilityWallTimeToIso(localMatch[1], localMatch[2]);
  }
  return raw;
}

function getFacilityTimeZoneOffsetMs(date) {
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    timeZoneName: "shortOffset"
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "GMT";
  const match = zoneName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * ((hours * 60) + minutes) * 60000;
}

function facilityWallTimeToIso(dateStr, timeStr = "00:00") {
  const [year, month, day] = String(dateStr || "").split("-").map(Number);
  const [hour, minute] = String(timeStr || "00:00").split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return String(dateStr || "");

  const wallTime = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utcTime = wallTime;
  for (let i = 0; i < 3; i += 1) {
    utcTime = wallTime - getFacilityTimeZoneOffsetMs(new Date(utcTime));
  }
  return new Date(utcTime).toISOString();
}

async function loadMembers(memberIds) {
  const idList = memberIds
    .map((id) => id.replace(/[^a-zA-Z0-9-_]/g, ""))
    .filter(Boolean)
    .join(",");
  if (!idList) return [];

  const rows = await supabaseRest(`account_members?select=id,member_name,phone_number,email_address,account_type&id=in.(${idList})`);
  return (rows || []).filter((member) => String(member.account_type || "").trim() !== "Rental Account");
}

function collectEmailRecipients(members) {
  const valid = [];
  const seen = new Set();
  const invalid = [];

  for (const member of members || []) {
    const rawEmail = String(member?.email_address || "").trim();
    if (!rawEmail) continue;

    const email = rawEmail.toLowerCase();
    if (!isValidEmailAddress(email)) {
      invalid.push({
        name: String(member?.member_name || "Unknown member").trim() || "Unknown member",
        email: rawEmail
      });
      continue;
    }

    if (!seen.has(email)) {
      seen.add(email);
      valid.push(email);
    }
  }

  return { valid, invalid };
}

function isValidEmailAddress(value) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(value || ""));
}

function formatInvalidEmailMembers(invalidRecipients) {
  return invalidRecipients
    .slice(0, 5)
    .map((recipient) => `${recipient.name} (${recipient.email})`)
    .join(", ")
    + (invalidRecipients.length > 5 ? `, and ${invalidRecipients.length - 5} more` : "");
}

async function createScheduledMemberMessage({
  createdByMemberId,
  rentalRequestId,
  title,
  message,
  memberIds,
  channels,
  scheduledFor,
  scheduleLabel,
  dispatchId
}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/scheduled_member_messages`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      created_by_member_id: createdByMemberId || null,
      rental_request_id: rentalRequestId || null,
      title,
      message,
      member_ids: memberIds || [],
      channels: channels || {},
      scheduled_for: scheduledFor,
      schedule_label: scheduleLabel || null,
      dispatch_id: dispatchId
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not schedule message: ${response.status} ${text}`);
  }

  const rows = await response.json().catch(() => []);
  return rows[0] || {};
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

function buildTextMessageBody(title, message) {
  const body = String(message || "").trim();
  return body || String(title || "").trim();
}

function buildMemberMessageEmails(recipients, subject, message) {
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replaceAll("\n", "<br />");
  const html = buildEmailTemplate({
    title: safeSubject,
    bodyHtml: `<p style="margin:0;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">${safeMessage}</p>`
  });
  return (recipients || []).map((to) => ({
      from: RESEND_FROM_EMAIL,
      to: [to],
      subject,
      text: message,
      html
  }));
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
