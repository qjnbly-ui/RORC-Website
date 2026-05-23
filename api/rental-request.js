const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Email notification via Resend (optional — all three vars must be set to send)
// RESEND_API_KEY  — API key from resend.com
// RORC_NOTIFY_EMAIL — admin address to receive notifications (e.g. info@rorcoregon.com)
// RORC_FROM_EMAIL  — verified Resend sender address (e.g. rentals@rorcoregon.com)
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RORC_NOTIFY_EMAIL = process.env.RORC_NOTIFY_EMAIL;
const RORC_FROM_EMAIL = process.env.RORC_FROM_EMAIL;

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

    // Fire-and-forget email — never block or fail the response
    sendNotificationEmail(savedRecord, body).catch((err) => {
      console.error("Rental notification email failed:", err);
    });

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

  return errors;
}

function buildRecord(body) {
  return {
    contact_name: str(body.contactName),
    contact_phone: str(body.contactPhone),
    contact_email: str(body.contactEmail).toLowerCase(),
    contact_address: str(body.contactAddress),

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

    agreed_to_no_guarantee: true,
    agreed_to_guidelines: true
  };
}

function str(value) {
  return String(value || "").trim();
}

async function sendNotificationEmail(record, body) {
  if (!RESEND_API_KEY || !RORC_NOTIFY_EMAIL || !RORC_FROM_EMAIL) return;

  const totalDollars = ((record?.estimated_total_cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

  const addons = [
    record?.addon_tables && "Tables ($20)",
    record?.addon_chairs && "Chairs ($20)",
    record?.addon_tarp && "Tarp ($20)",
    record?.addon_heater && "Heater ($13/hr)",
    record?.addon_early_setup && "Early Setup ($50)",
    record?.addon_early_day_rental && "Extra Day — Early ($100)",
    record?.addon_late_cleanup && "Late Cleanup ($50)",
    record?.addon_late_day_rental && "Extra Day — Late ($100)"
  ].filter(Boolean);

  const html = `
<h2 style="margin:0 0 16px;font-family:sans-serif;">New Rental Request</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;width:100%;max-width:560px;">
  <tr><td style="padding:6px 12px 6px 0;color:#666;white-space:nowrap;">Name</td><td style="padding:6px 0;">${esc(record?.contact_name)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;">Phone</td><td style="padding:6px 0;">${esc(record?.contact_phone)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;">Email</td><td style="padding:6px 0;">${esc(record?.contact_email)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;">Address</td><td style="padding:6px 0;">${esc(record?.contact_address)}</td></tr>
  <tr><td colspan="2" style="padding:14px 0 6px;border-top:1px solid #eee;font-weight:600;">Event Details</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;">Type</td><td style="padding:6px 0;">${esc(record?.event_type)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;">Date</td><td style="padding:6px 0;">${esc(record?.event_date)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;">Time</td><td style="padding:6px 0;">${esc(record?.event_start_time)} – ${esc(record?.event_end_time)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;">Attendance</td><td style="padding:6px 0;">${esc(String(record?.estimated_attendance || ""))}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;">Food/Drinks</td><td style="padding:6px 0;">${record?.food_or_drinks ? "Yes" : "No"}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#666;">Alcohol</td><td style="padding:6px 0;">${esc(record?.alcohol)}</td></tr>
  ${addons.length ? `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;">Add-Ons</td><td style="padding:6px 0;">${addons.map(esc).join("<br />")}</td></tr>` : ""}
  <tr><td style="padding:14px 12px 6px 0;border-top:1px solid #eee;color:#666;font-weight:600;">Est. Total</td><td style="padding:14px 0 6px;font-weight:600;">${totalDollars}</td></tr>
</table>
<p style="margin:20px 0 0;font-family:sans-serif;font-size:13px;color:#888;">Review this request in the RORC app under Rentals.</p>
`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RORC_FROM_EMAIL,
      to: [RORC_NOTIFY_EMAIL],
      subject: `New Rental Request — ${record?.event_type || "Event"} on ${record?.event_date || "TBD"}`,
      html
    })
  });
}

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
