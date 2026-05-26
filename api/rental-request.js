const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Email notification via Resend (optional — RESEND_API_KEY + RORC_NOTIFY_EMAIL must be set to send)
// RESEND_API_KEY    — API key from resend.com
// RORC_NOTIFY_EMAIL — admin address to receive notifications (e.g. info@rorcoregon.com)
// RESEND_FROM_EMAIL — verified Resend sender (defaults to "RORC App <no-reply@ruthobenchainrc.com>")
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RORC_NOTIFY_EMAIL = process.env.RORC_NOTIFY_EMAIL;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";
const { sendResendEmail } = require("./_resend");

const VALID_EVENT_TYPES = ["Birthday Party", "Private Party", "Meeting", "Memorial Service", "Other"];
const VALID_ALCOHOL_VALUES = ["Yes", "No"];
const FACILITY_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_FACILITY_START = "07:00";
const DEFAULT_FACILITY_END = "21:00";
const RENTAL_PRICE_CENTS = {
  allDay: 10000,
  privateHourly: 1000,
  nonPrivateHourly: 500,
  cleaningMaintenance: 2000,
  tables: 2000,
  chairs: 2000,
  tarp: 2000,
  earlySetup: 5000,
  earlyDayRental: 10000,
  lateCleanup: 5000,
  lateDayRental: 10000
};
const SPECIAL_ACCESS_RENTAL_DISCOUNT_RATE = 0.2;

function normalizeRentalHours(value, fallback = 1) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(9, Math.max(0.01, Math.round(hours * 100) / 100));
}

function normalizeRentalBillableHours(value, fallback = 1) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(24, Math.max(0.01, Math.round(hours * 100) / 100));
}

function rentalHoursLabel(value) {
  const hours = normalizeRentalHours(value);
  const label = String(Number(hours.toFixed(2)));
  return `${label} hr${hours === 1 ? "" : "s"}`;
}

function rentalBillableHoursLabel(value) {
  const hours = normalizeRentalBillableHours(value);
  const label = String(Number(hours.toFixed(2)));
  return `${label} hr${hours === 1 ? "" : "s"}`;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

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

  try {
    const specialAccessDiscount = await getVerifiedSpecialAccessDiscount(req);
    const record = buildRecord(body, { specialAccessDiscount });
    const facilityHoursError = await validateRentalInsideFacilityHours(record);
    if (facilityHoursError) {
      return res.status(409).json({ success: false, error: facilityHoursError });
    }

    const conflict = await findConfirmedRentalConflict(record);
    if (conflict) {
      return res.status(409).json({
        success: false,
        error: "That rental access time overlaps another confirmed booking. Please choose a different time."
      });
    }

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
        addon_cleaning_maintenance: body.addonCleaningMaintenance === true,
        addon_ac: body.addonAc === true
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
  const rentalAccessError = orderedTimePairError(body.eventStartTime, body.eventEndTime, "Rental access");
  if (str(body.eventStartTime) && str(body.eventEndTime) && rentalAccessError) errors.push(rentalAccessError);
  const publicStart = str(body.publicEventStartTime);
  const publicEnd = str(body.publicEventEndTime);
  if ((publicStart && !publicEnd) || (!publicStart && publicEnd)) {
    errors.push("Public calendar start/end time must both be set, or both be blank.");
  }
  const publicTimeError = orderedTimePairError(publicStart, publicEnd, "Public event");
  if (publicStart && publicEnd && publicTimeError) errors.push(publicTimeError);

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
    if (!Number.isFinite(hours) || hours <= 0 || hours > 9) errors.push("Hourly rental duration must be greater than 0 and no more than 9 hours.");
  }

  return errors;
}

function buildRecord(body, options = {}) {
  const publicStart = str(body.publicEventStartTime);
  const publicEnd = str(body.publicEventEndTime);
  const rentalType = ["all_day", "hourly"].includes(str(body.rentalType)) ? str(body.rentalType) : "all_day";
  const record = {
    contact_name: str(body.contactName),
    contact_phone: str(body.contactPhone),
    contact_email: str(body.contactEmail).toLowerCase(),
    contact_address: str(body.contactAddress),

    event_name: str(body.eventName).slice(0, 120),
    event_type: str(body.eventType),
    event_date: str(body.eventDate),
    event_start_time: str(body.eventStartTime),
    event_end_time: str(body.eventEndTime),
    ...(publicStart && publicEnd ? {
      public_event_start_time: publicStart,
      public_event_end_time: publicEnd
    } : {}),
    estimated_attendance: Number(body.estimatedAttendance),
    food_or_drinks: body.foodOrDrinks === true,
    alcohol: str(body.alcohol),

    addon_tables: body.addonTables === true,
    addon_chairs: body.addonChairs === true,
    addon_tarp: body.addonTarp === true,
    addon_heater: body.addonHeater === true,
    addon_ac: body.addonAc === true,
    addon_early_setup: body.addonEarlySetup === true,
    addon_early_day_rental: body.addonEarlyDayRental === true,
    addon_late_cleanup: body.addonLateCleanup === true,
    addon_late_day_rental: body.addonLateDayRental === true,

    estimated_total_cents: 0,
    is_private_event: body.isPrivateEvent !== false,
    special_access_discount: options.specialAccessDiscount === true,

    rental_type: rentalType,
    rental_hours: rentalType === "hourly" ? normalizeRentalHours(body.rentalHours) : null,

    agreed_to_no_guarantee: true,
    agreed_to_guidelines: true
  };
  record.estimated_total_cents = calculateRentalTotalCents({
    ...record,
    addon_cleaning_maintenance: body.addonCleaningMaintenance === true
  });
  return record;
}

function rentalHoursBetween(startValue, endValue, fallback = 1) {
  const start = parseTimeMinutes(startValue);
  const end = parseTimeMinutes(endValue);
  if (start === null || end === null || end <= start) return fallback;
  return normalizeRentalBillableHours((end - start) / 60, fallback);
}

function calculateRentalTotalCents(record) {
  const isPrivateEvent = record?.is_private_event !== false;
  let total;
  if (!isPrivateEvent) {
    total = Math.round(
      rentalHoursBetween(record?.event_start_time, record?.event_end_time, record?.rental_hours || 1)
      * RENTAL_PRICE_CENTS.nonPrivateHourly
    );
  } else if (record?.rental_type === "hourly") {
    total = Math.round(normalizeRentalHours(record?.rental_hours || 1) * RENTAL_PRICE_CENTS.privateHourly);
  } else {
    total = RENTAL_PRICE_CENTS.allDay;
  }

  if (record?.addon_cleaning_maintenance) total += RENTAL_PRICE_CENTS.cleaningMaintenance;
  if (record?.addon_tables) total += RENTAL_PRICE_CENTS.tables;
  if (record?.addon_chairs) total += RENTAL_PRICE_CENTS.chairs;
  if (record?.addon_tarp) total += RENTAL_PRICE_CENTS.tarp;
  if (record?.addon_early_setup) total += RENTAL_PRICE_CENTS.earlySetup;
  if (record?.addon_early_day_rental) total += RENTAL_PRICE_CENTS.earlyDayRental;
  if (record?.addon_late_cleanup) total += RENTAL_PRICE_CENTS.lateCleanup;
  if (record?.addon_late_day_rental) total += RENTAL_PRICE_CENTS.lateDayRental;
  if (record?.special_access_discount) {
    total = Math.round(total * (1 - SPECIAL_ACCESS_RENTAL_DISCOUNT_RATE));
  }
  return Math.max(0, total);
}

async function findConfirmedRentalConflict(record) {
  const requestDate = String(record.event_date || "").slice(0, 10);
  const requestStart = parseTimeMinutes(record.event_start_time);
  const requestEnd = parseTimeMinutes(record.event_end_time);
  if (!requestDate || requestStart === null || requestEnd === null || requestEnd <= requestStart) return null;

  const [eventRows, rentalRows] = await Promise.all([
    supabaseRest(
      "events?select=start_at,end_at,event_type,all_day,rental_requests(event_date,event_start_time,event_end_time,rental_type)&event_type=in.(rental,maintenance)&status=eq.confirmed&order=start_at.asc&limit=500"
    ),
    supabaseRest(
      "rental_requests?select=event_date,event_start_time,event_end_time,rental_type&rental_status=eq.confirmed&order=event_date.asc&limit=500"
    )
  ]);
  const rows = [...eventRows.filter(isStandaloneConflictEvent), ...rentalRows.map((rental) => ({
    event_type: "rental",
    all_day: false,
    rental_requests: rental
  }))];

  return (rows || []).find((row) => {
    const block = eventRentalBlock(row);
    if (!block || block.date !== requestDate) return false;
    return requestStart < block.end && requestEnd > block.start;
  }) || null;
}

function eventRentalBlock(row) {
  const rental = row?.rental_requests || null;
  const rentalDate = String(rental?.event_date || "").slice(0, 10);
  const rentalStart = parseTimeMinutes(rental?.event_start_time);
  const rentalEnd = parseTimeMinutes(rental?.event_end_time);
  if (rentalDate && rentalStart !== null && rentalEnd !== null && rentalEnd > rentalStart) {
    return { date: rentalDate, start: rentalStart, end: rentalEnd };
  }

  const date = row?.all_day ? rawDateKey(row.start_at) : facilityDateKey(row?.start_at);
  if (!date) return null;
  if (row?.all_day) return { date, start: 0, end: 1440 };
  const start = parseTimeMinutes(facilityTimeValue(row?.start_at));
  const end = parseTimeMinutes(facilityTimeValue(row?.end_at));
  if (start === null || end === null || end <= start) return null;
  return { date, start, end };
}

function isStandaloneConflictEvent(row) {
  return String(row?.event_type || "") !== "rental" || !row?.rental_requests;
}

function parseTimeMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour * 60) + minute;
}

function orderedTimePairError(startValue, endValue, label) {
  const start = parseTimeMinutes(startValue);
  const end = parseTimeMinutes(endValue);
  if (start === null || end === null) return `${label} start/end time must be valid.`;
  if (end <= start) return `${label} end time must be after start time.`;
  return "";
}

async function validateRentalInsideFacilityHours(record) {
  const dateKey = String(record.event_date || "").slice(0, 10);
  const start = parseTimeMinutes(record.event_start_time);
  const end = parseTimeMinutes(record.event_end_time);
  if (!dateKey || start === null || end === null || end <= start) return "Rental access time must be valid.";

  const facilityHours = await loadCalendarSettings();
  const hours = facilityHoursForDate(facilityHours, dateKey);
  if (hours.closed) return "RORC is closed on the selected date. Please choose another day.";

  const facilityStart = parseTimeMinutes(hours.start);
  const facilityEnd = parseTimeMinutes(hours.end);
  if (facilityStart === null || facilityEnd === null || facilityEnd <= facilityStart) {
    return "Facility hours are unavailable for the selected date. Please call RORC.";
  }
  if (start < facilityStart || end > facilityEnd) {
    return `Rental access must be within facility hours (${formatHourLabel(hours.start)} - ${formatHourLabel(hours.end)}).`;
  }
  return "";
}

async function loadCalendarSettings() {
  try {
    const rows = await supabaseRest("automation_settings?select=config&id=eq.calendar_settings&limit=1");
    const config = rows[0]?.config || {};
    return {
      facility_start: normalizeHourValue(config.facility_start || config.start, DEFAULT_FACILITY_START),
      facility_end: normalizeHourValue(config.facility_end || config.end, DEFAULT_FACILITY_END),
      overrides: normalizeFacilityHourOverrides(config.overrides || {})
    };
  } catch {
    return { facility_start: DEFAULT_FACILITY_START, facility_end: DEFAULT_FACILITY_END, overrides: {} };
  }
}

function facilityHoursForDate(settings, dateKey) {
  const override = settings?.overrides?.[dateKey];
  if (override?.closed) return { closed: true };
  if (override?.start && override?.end) return override;
  return {
    start: settings?.facility_start || DEFAULT_FACILITY_START,
    end: settings?.facility_end || DEFAULT_FACILITY_END
  };
}

function normalizeFacilityHourOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.entries(raw).forEach(([dateKey, value]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !value || typeof value !== "object") return;
    if (value.closed === true) {
      out[dateKey] = { closed: true };
      return;
    }
    const start = normalizeHourValue(value.start || value.facility_start, "");
    const end = normalizeHourValue(value.end || value.facility_end, "");
    if (start && end) out[dateKey] = { start, end };
  });
  return out;
}

function normalizeHourValue(raw, fallback) {
  const match = String(raw || "").match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1]}:${match[2]}` : fallback;
}

function formatHourLabel(timeValue) {
  const minutes = parseTimeMinutes(timeValue);
  if (minutes === null) return String(timeValue || "");
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 || 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

function rawDateKey(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function facilityDateKey(value) {
  const raw = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.slice(0, 10);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function facilityTimeValue(value) {
  const raw = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.slice(11, 16);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
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
    throw new Error(`REST failed: ${response.status} ${text}`);
  }
  return response.json();
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function canonicalAccountType(accountType) {
  const normalized = String(accountType || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "special access account" || normalized === "billed monthly") return "Special Access Account";
  return String(accountType || "").trim();
}

async function getVerifiedSpecialAccessDiscount(req) {
  const token = bearerToken(req);
  if (!token) return false;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`
      }
    });
    if (!userRes.ok) return false;
    const user = await userRes.json();
    const authUserId = user?.id || "";
    const email = String(user?.email || "").trim().toLowerCase();

    if (authUserId) {
      const rows = await supabaseRest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
      if (canonicalAccountType(rows?.[0]?.account_type) === "Special Access Account") return true;
    }
    if (email) {
      const rows = await supabaseRest(`account_member_profiles?select=account_member_id,account_type,email_address&email_address=eq.${encodeURIComponent(email)}&limit=1`);
      if (canonicalAccountType(rows?.[0]?.account_type) === "Special Access Account") return true;
    }
  } catch (error) {
    console.warn("Special Access discount verification skipped:", error?.message || error);
  }
  return false;
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
    record?.is_private_event === false && "Non-private event ($5/hr)",
    record?.special_access_discount && "Special Access discount (20%)",
    record?.addon_cleaning_maintenance && "Standard Maintenance Fee ($20)",
    record?.addon_tables && "Tables ($20)",
    record?.addon_chairs && "Chairs ($20)",
    record?.addon_tarp && "Tarp ($20)",
    record?.addon_heater && "Heater ($13/hr)",
    record?.addon_ac && "AC ($2/hr)",
    record?.addon_early_setup && "Early Setup ($50)",
    record?.addon_early_day_rental && "Extra Day — Early ($100)",
    record?.addon_late_cleanup && "Late Cleanup ($50)",
    record?.addon_late_day_rental && "Extra Day — Late ($100)"
  ].filter(Boolean);

  const rentalTypeLabel = record?.is_private_event === false
    ? `Non-private (${rentalBillableHoursLabel(rentalHoursBetween(record?.event_start_time, record?.event_end_time, record?.rental_hours || 1))} @ $5/hr)`
    : record?.rental_type === "hourly"
      ? `By the Hour (${rentalHoursLabel(record?.rental_hours || 1)})`
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
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Rental Time</td><td style="padding:6px 0;">${esc(record?.event_start_time)} – ${esc(record?.event_end_time)}</td></tr>
  ${record?.public_event_start_time && record?.public_event_end_time
    ? `<tr><td style="padding:6px 12px 6px 0;color:#888;">Public Event Time</td><td style="padding:6px 0;">${esc(record?.public_event_start_time)} – ${esc(record?.public_event_end_time)}</td></tr>`
    : ""}
  <tr><td style="padding:6px 12px 6px 0;color:#888;">Attendance</td><td style="padding:6px 0;">${esc(String(record?.estimated_attendance || ""))}</td></tr>
  ${addons.length ? `<tr><td style="padding:6px 12px 6px 0;color:#888;vertical-align:top;">Add-Ons</td><td style="padding:6px 0;">${addons.map(esc).join("<br>")}</td></tr>` : ""}
  <tr><td style="padding:18px 12px 8px 0;border-top:1px solid #333;color:#888;font-weight:600;">Est. Total</td><td style="padding:18px 0 8px;font-weight:600;color:#fff;">${esc(totalDollars)}</td></tr>
</table>
<p style="margin:24px 0 0;color:#888;font-size:13px;">Review this request in the RORC app under <strong style="color:#ccc;">Rentals</strong>.</p>
`;

  const responseBody = await sendResendEmail({
    apiKey: RESEND_API_KEY,
    from: RESEND_FROM_EMAIL,
    to: [RORC_NOTIFY_EMAIL],
    subject: `New Rental Request - ${record?.event_type || "Event"} on ${record?.event_date || "TBD"}`,
    html: buildEmailTemplate({ title: "New Rental Request", bodyHtml }),
    idempotencyKey: `rental-request-${record?.id || record?.event_date || Date.now()}`
  });

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
