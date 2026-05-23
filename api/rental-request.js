const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    return res.status(200).json({ success: true, id: rows[0]?.id });
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
