const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Email notification via Resend (optional — RESEND_API_KEY + RORC_NOTIFY_EMAIL must be set to send)
// RESEND_API_KEY    — API key from resend.com
// RORC_NOTIFY_EMAIL — admin address to receive notifications (e.g. info@rorcoregon.com)
// RESEND_FROM_EMAIL — verified Resend sender (defaults to "RORC App <no-reply@ruthobenchainrc.com>")
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RORC_NOTIFY_EMAIL = process.env.RORC_NOTIFY_EMAIL;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";

const VALID_EVENT_TYPES = ["Birthday Party", "Private Party", "Meeting", "Memorial Service", "Other"];
const VALID_ALCOHOL_VALUES = ["Yes", "No", "Maybe"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Server configuration error" });
  }

  const body = req.body || {};
  const errors = validate(body);
  if (errors.length) {
    return res.status(400).json({ success: false, errors });
  }

  const record = buildRecord(body);

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rental_requests`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(record)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Supabase insert failed:", response.status, text);
      return res.status(500).json({ success: false, error: "Could not save rental request. Please try again or call RORC directly." });
    }

    const rows = await response.json();
    const savedRecord = rows[0];

    // Wait for the notification attempt so serverless runtimes do not drop it after the response.
    try {
      await sendNotificationEmail({
        ...savedRecord,
        addon_cleaning_maintenance: body.addonCleaningMaintenance === true
      });
    } catch (err) {
      console.error("Rental notification email failed:", err);
    }

    return res.status(200).json({ success: true, id: savedRecord?.id });
  } catch (err) {
    console.error("rental-request error:", err);
    return res.status(500).json({ success: false, error: "Server error. Please try again or call RORC directly." });
  }
};

function validate(body) {
  const errors = [];

  if (!str(body.contactName)) errors.push("Primary contact name is required.");
  if (!str(body.contactPhone)) errors.push("Phone number is required.");
  if (!str(body.contactEmail) || !body.contactEmail.includes("@")) errors.push("A valid email address is required.");
  if (!str(body.contactAddress)) errors.push("Mailing address is required.");

  if (!str(body.eventName)) errors.push("Event name is required.");
  if (!VALID_EVENT_TYPES.includes(str(body.eventType))) errors.push("A valid event type is required.");
  if (!str(body.eventDate) || isNaN(Date.parse(body.eventDate))) errors.push("A valid event date is required.");
  if (!str(body.eventStartTime)) errors.push("Event start time is required.");
  if (!str(body.eventEndTime)) errors.push("Event end time is required.");

  const attendance = Number(body.estimatedAttendance);
  if (!Number.isInteger(attendance) || attendance < 1) errors.push("Estimated attendance must be at least 1.");

  if (body.foodOrDrinks !== true && body.foodOrDrinks !== false) errors.push("Please indicate whether food or drinks will be served.");
  if (!VALID_ALCOHOL_VALUES.includes(str(body.alcohol))) errors.push("Please indicate whether alcohol will be at the event.");

  if (body.agreedToNoGuarantee !== true) errors.push("Please acknowledge the booking terms.");
  if (body.agreedToGuidelines !== true) errors.push("Please agree to the RORC rental guidelines.");

  const rentalType = str(body.rentalType) || "all_day";
  if (!["all_day", "hourly"].includes(rentalType)) errors.push("Invalid rental type.");
  if (rentalType === "hourly") {
    const hours = Number(body.rentalHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 9) errors.push("Number of hours must be between 1 and 9.");
  }

  return errors;
}

function buildRecord(body) {
  return {
    contact_name: str(body.contactName),
    contact_phone: str(body.contactPhone),
    contact_email: str(body.contactEmail).toLowerCase(),
    contact_address: str(body.contactAddress),

    event_name: str(body.eventName).slice(0, 120),
    event_type: str(body.eventType),
    event_date: str(body.eventDate),
    event_start_time: str(body.eventStartTime),
    event_end_time: str(body.eventEndTime),
    estimated_attendance: Number(body.estimatedAttendance),
    food_or_drinks: body.foodOrDrinks === true,
    alcohol: str(body.alcohol),

    addon_tables: body.addonTables === true,
    addon_chairs: body.addonChairs === true,
    addon_tarp: body.addonTarp === true,
    addon_heater: body.addonHeater === true,
    addon_early_setup: body.addonEarlySetup === true,
    addon_early_day_rental: body.addonEarlyDayRental === true,
    addon_late_cleanup: body.addonLateCleanup === true,
    addon_late_day_rental: body.addonLateDayRental === true,

    estimated_total_cents: Math.max(0, Number(body.estimatedTotalCents) || 0),

    rental_type: ["all_day", "hourly"].includes(str(body.rentalType)) ? str(body.rentalType) : "all_day",
    rental_hours: str(body.rentalType) === "hourly" ? Math.min(9, Math.max(1, Number(body.rentalHours) || 1)) : null,

    agreed_to_no_guarantee: true,
    agreed_to_guidelines: true
  };
}

function str(value) {
  return String(value || "").trim();
}

async function sendNotificationEmail(record) {
  if (!RESEND_API_KEY) {
    console.warn("Rental notification email skipped: RESEND_API_KEY is not configured.");
    return null;
  }
  if (!RORC_NOTIFY_EMAIL) {
    console.warn("Rental notification email skipped: RORC_NOTIFY_EMAIL is not configured.");
    return null;
  }

  const totalDollars = ((record?.estimated_total_cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

  const addons = [
    record?.addon_cleaning_maintenance && "Cleaning & Maintenance ($20)",
    record?.addon_tables && "Tables ($20)",
    record?.addon_chairs && "Chairs ($20)",
    record?.addon_tarp && "Tarp ($20)",
    record?.addon_heater && "Heater ($13/hr)",
    record?.addon_early_setup && "Early Setup ($50)",
    record?.addon_early_day_rental && "Extra Day — Early ($100)",
    record?.addon_late_cleanup && "Late Cleanup ($50)",
    record?.addon_late_day_rental && "Extra Day — Late ($100)"
  ].filter(Boolean);

  const rentalTypeLabel = record?.rental_type === "hourly"
    ? `By the Hour (${record?.rental_hours || 1} hr${record?.rental_hours !== 1 ? "s" : ""})`
    : "All Day (7 AM – 9 PM)";

  const bodyHtml = `
<p style="margin:0 0 20px;color:#ccc;font-size:15px;">A new facility rental request has been submitted and is waiting for review.</p>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;color:#f5f5f5;">
  <tr><td style="padding:6px 12px 6px 0;color:#888;white-space:nowrap;">Name</td><td style="padding:6px 0;">${esc(record?.contact_name)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Phone</td><td style="padding:6px 0;">${esc(record?.contact_phone)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Email</td><td style="padding:6px 0;">${esc(record?.contact_email)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Address</td><td style="padding:6px 0;">${esc(record?.contact_address)}</td></tr>
  <tr><td colspan="2" style="padding:18px 0 8px;border-top:1px solid #333;font-weight:600;color:#fff;">Event Details</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Event Name</td><td style="padding:6px 0;">${esc(record?.event_name)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Type</td><td style="padding:6px 0;">${esc(record?.event_type)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Rental</td><td style="padding:6px 0;">${esc(rentalTypeLabel)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Date</td><td style="padding:6px 0;">${esc(record?.event_date)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Time</td><td style="padding:6px 0;">${esc(record?.event_start_time)} – ${esc(record?.event_end_time)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Attendance</td><td style="padding:6px 0;">${esc(String(record?.estimated_attendance || ""))}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Food/Drinks</td><td style="padding:6px 0;">${record?.food_or_drinks ? "Yes" : "No"}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Alcohol</td><td style="padding:6px 0;">${esc(record?.alcohol)}</td></tr>
  ${addons.length ? `<tr><td style="padding:6px 12px 6px 0;color:#888;vertical-align:top;">Add-Ons</td><td style="padding:6px 0;">${addons.map(esc).join("<br>")}</td></tr>` : ""}
  <tr><td style="padding:18px 12px 8px 0;border-top:1px solid #333;color:#888;font-weight:600;">Est. Total</td><td style="padding:18px 0 8px;font-weight:600;color:#fff;">${esc(totalDollars)}</td></tr>
</table>
<p style="margin:24px 0 0;color:#888;font-size:13px;">Review this request in the RORC app under <strong style="color:#ccc;">Rentals</strong>.</p>
`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [RORC_NOTIFY_EMAIL],
      subject: `New Rental Request — ${record?.event_type || "Event"} on ${record?.event_date || "TBD"}`,
      html: buildEmailTemplate({ title: "New Rental Request", bodyHtml })
    })
  });

  const responseText = await response.text();
  let responseBody = null;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {}

  if (!response.ok) {
    throw new Error(`Resend rental notification failed: ${response.status} ${responseText}`);
  }

  console.info(`Rental notification email sent to ${RORC_NOTIFY_EMAIL}.`, responseBody?.id ? `Resend id: ${responseBody.id}` : "");
  return responseBody;
}

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
          <td style="padding:20px 28px;text-align:left;">
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
