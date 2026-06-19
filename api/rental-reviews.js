const crypto = require("crypto");
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";
const { buildRentalApplicantEmail } = require("./_communication-templates");
const { sendResendEmail } = require("./_resend");

const VALID_STATUSES = ["submitted", "pending_review", "confirmed", "rejected", "canceled"];
const VALID_CHANGE_REVIEW_ACTIONS = new Set(["approve", "reject"]);
const FACILITY_TIME_ZONE = "America/Los_Angeles";
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://ruthobenchainrc.com").replace(/\/+$/, "");
const CLAIM_LINK_DAYS = 30;
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

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Server configuration error" });
  }

  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: "Missing session token" });
  }

  let manager;
  try {
    const user = await getSupabaseUser(token);
    manager = await getAccountMember(user.id);
    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Admin access required" });
    }
  } catch {
    return res.status(401).json({ success: false, error: "Invalid session" });
  }

  if (req.method === "GET") {
    try {
      const rows = await supabaseRest(
        "rental_requests?select=*&order=event_date.asc&order=created_at.asc&limit=200"
      );
      const rentalIds = rows.map((row) => row.id);
      const [linkedEvents, changeRequests] = await Promise.all([
        loadLinkedCalendarEventMap(rentalIds),
        loadRentalChangeRequestsMap(rentalIds)
      ]);
      return res.status(200).json({
        success: true,
        requests: rows.map((row) => mapRow(row, linkedEvents.get(row.id), changeRequests.get(row.id) || []))
      });
    } catch (err) {
      console.error("rental-reviews GET error:", err);
      return res.status(500).json({ success: false, error: "Could not load rental requests" });
    }
  }

  if (req.method === "POST") {
    const { event_date } = req.body || {};
    if (!event_date) {
      return res.status(400).json({ success: false, error: "event_date is required" });
    }
    const publicStart = str(req.body?.public_event_start_time || req.body?.publicEventStartTime);
    const publicEnd = str(req.body?.public_event_end_time || req.body?.publicEventEndTime);
    if (Boolean(publicStart) !== Boolean(publicEnd)) {
      return res.status(400).json({ success: false, error: "public event start/end must both be set or both be blank" });
    }
    const rentalTimeError = orderedTimePairError(
      req.body?.event_start_time || req.body?.eventStartTime || "07:00",
      req.body?.event_end_time || req.body?.eventEndTime || "21:00",
      "rental access"
    );
    if (rentalTimeError) {
      return res.status(400).json({ success: false, error: rentalTimeError });
    }
    const publicTimeError = publicStart && publicEnd ? orderedTimePairError(publicStart, publicEnd, "public event") : "";
    if (publicTimeError) {
      return res.status(400).json({ success: false, error: publicTimeError });
    }
    try {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/rental_requests`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(buildRentalRecord(req.body || {}))
      });
      if (!insertRes.ok) {
        const text = await insertRes.text();
        throw new Error(`Insert failed: ${insertRes.status} ${text}`);
      }
      const rows = await insertRes.json();
      return res.status(200).json({ success: true, id: rows[0]?.id });
    } catch (err) {
      console.error("rental-reviews POST error:", err);
      return res.status(500).json({ success: false, error: err.message || "Could not create rental request" });
    }
  }

  if (req.method === "PATCH") {
    const { id, status, adminNotes, changeRequestId, action, reviewNotes } = req.body || {};

    if (changeRequestId) {
      if (!VALID_CHANGE_REVIEW_ACTIONS.has(String(action || ""))) {
        return res.status(400).json({ success: false, error: "Invalid change request action" });
      }
      try {
        const result = await reviewRentalChangeRequest({
          changeRequestId,
          action,
          reviewNotes,
          manager,
          req
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("rental change request review error:", err);
        return res.status(Number(err.statusCode) || 500).json({ success: false, error: err.message || "Could not review renter request" });
      }
    }

    if (!id || typeof id !== "string") {
      return res.status(400).json({ success: false, error: "Missing rental request ID" });
    }
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
    }
    const patchPublicStartProvided = hasBodyField(req.body, "public_event_start_time") || hasBodyField(req.body, "publicEventStartTime");
    const patchPublicEndProvided = hasBodyField(req.body, "public_event_end_time") || hasBodyField(req.body, "publicEventEndTime");
    const patchPublicStart = bodyFieldValue(req.body, "public_event_start_time", "publicEventStartTime");
    const patchPublicEnd = bodyFieldValue(req.body, "public_event_end_time", "publicEventEndTime");
    const patchRentalStartProvided = hasBodyField(req.body, "event_start_time") || hasBodyField(req.body, "eventStartTime");
    const patchRentalEndProvided = hasBodyField(req.body, "event_end_time") || hasBodyField(req.body, "eventEndTime");
    const patchRentalStart = bodyFieldValue(req.body, "event_start_time", "eventStartTime");
    const patchRentalEnd = bodyFieldValue(req.body, "event_end_time", "eventEndTime");
    if (patchRentalStartProvided || patchRentalEndProvided) {
      if (!patchRentalStartProvided || !patchRentalEndProvided) {
        return res.status(400).json({ success: false, error: "rental access start/end must both be set" });
      }
      const rentalTimeError = orderedTimePairError(patchRentalStart, patchRentalEnd, "rental access");
      if (rentalTimeError) {
        return res.status(400).json({ success: false, error: rentalTimeError });
      }
    }
    if ((patchPublicStartProvided || patchPublicEndProvided)
      && Boolean(str(patchPublicStart)) !== Boolean(str(patchPublicEnd))) {
      return res.status(400).json({ success: false, error: "public event start/end must both be set or both be blank" });
    }
    const publicTimeError = str(patchPublicStart) && str(patchPublicEnd)
      ? orderedTimePairError(patchPublicStart, patchPublicEnd, "public event")
      : "";
    if (publicTimeError) {
      return res.status(400).json({ success: false, error: publicTimeError });
    }

    try {
      const calendarPublicOverride = calendarPublicOverrideFromBody(req.body || {});
      const existingRows = await supabaseRest(`rental_requests?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
      const existingRecord = existingRows[0] || {};
      const patchBody = buildRentalPatch(req.body || {}, existingRecord);
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/rental_requests?id=eq.${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify(patchBody)
        }
      );

      if (!patchRes.ok) {
        const text = await patchRes.text();
        throw new Error(`Supabase PATCH failed: ${patchRes.status} ${text}`);
      }

      const rows = await patchRes.json();
      const record = rows[0];

      const automationWarnings = record
        ? await runRentalReviewAutomations(record, status, adminNotes, { calendarPublicOverride, req })
        : [];
      const linkedEvents = record
        ? await loadLinkedCalendarEventMap([record.id])
        : new Map();
      const changeRequests = record
        ? await loadRentalChangeRequestsMap([record.id])
        : new Map();

      return res.status(200).json({
        success: true,
        request: record ? mapRow(record, linkedEvents.get(record.id), changeRequests.get(record.id) || []) : null,
        automationWarnings
      });
    } catch (err) {
      console.error("rental-reviews PATCH error:", err);
      return res.status(500).json({ success: false, error: err.message || "Could not update rental request" });
    }
  }

  if (req.method === "DELETE") {
    const { id, delete_linked_event, deleteLinkedEvent } = req.body || {};
    if (!id || typeof id !== "string") {
      return res.status(400).json({ success: false, error: "Missing rental request ID" });
    }

    try {
      const removeLinkedEvent = Boolean(delete_linked_event ?? deleteLinkedEvent);

      if (removeLinkedEvent) {
        const eventDeleteRes = await fetch(
          `${SUPABASE_URL}/rest/v1/events?rental_request_id=eq.${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            headers: {
              apikey: SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`
            }
          }
        );
        if (!eventDeleteRes.ok) {
          const text = await eventDeleteRes.text();
          throw new Error(`Linked event delete failed: ${eventDeleteRes.status} ${text}`);
        }
      }

      const deleteRes = await fetch(
        `${SUPABASE_URL}/rest/v1/rental_requests?id=eq.${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`
          }
        }
      );

      if (!deleteRes.ok) {
        const text = await deleteRes.text();
        throw new Error(`Rental request delete failed: ${deleteRes.status} ${text}`);
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("rental-reviews DELETE error:", err);
      return res.status(500).json({ success: false, error: "Could not delete rental request" });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
};

async function createOrUpdateCalendarEvent(record, options = {}) {
  const dateStr = record.event_date; // "YYYY-MM-DD"
  const rentalStartTime = record.event_start_time || "07:00";
  const rentalEndTime   = record.event_end_time   || "21:00";
  const publicStartTime = str(record.public_event_start_time || "");
  const publicEndTime   = str(record.public_event_end_time || "");
  const usePublicWindow = Boolean(publicStartTime && publicEndTime);
  const isAllDayRental = record.rental_type !== "hourly";
  const renderAsAllDay = isAllDayRental && !usePublicWindow;
  const startAt = buildIsoTimestamp(dateStr, renderAsAllDay ? "07:00" : (publicStartTime || rentalStartTime));
  const endAt   = buildIsoTimestamp(dateStr, renderAsAllDay ? "21:00" : (publicEndTime || rentalEndTime));

  const title = record.event_name
    ? String(record.event_name).trim()
    : `${record.event_type} - ${record.contact_name}`;

  const existingRows = await supabaseRest(
    `events?select=id,is_public,created_by&rental_request_id=eq.${encodeURIComponent(record.id)}`
  );
  const existingMainEvent = (existingRows || []).find((event) => String(event?.created_by || "").includes(":calendar:main"))
    || existingRows[0]
    || null;
  const calendarPublicOverride = options.calendarPublicOverride || {};

  const createdByBase = record.claimed_member_id
    ? `member:${record.claimed_member_id}:rental:${record.id}`
    : calendarCreatedByBase(existingMainEvent?.created_by);
  const mainPayload = {
    title,
    event_type: "rental",
    start_at: startAt,
    end_at:   endAt,
    all_day:  renderAsAllDay,
    is_public: calendarPublicOverride.provided
      ? Boolean(calendarPublicOverride.value)
      : existingMainEvent ? Boolean(existingMainEvent.is_public) : usePublicWindow,
    status: "confirmed",
    rental_request_id: record.id,
    created_by: `${createdByBase}:calendar:main`
  };

  const payloads = [
    mainPayload,
    ...rentalExtensionCalendarPayloads(record, title, createdByBase)
  ];

  if (existingRows.length) {
    const deleteRes = await fetch(
      `${SUPABASE_URL}/rest/v1/events?rental_request_id=eq.${encodeURIComponent(record.id)}`,
      {
        method: "DELETE",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          Prefer: "return=minimal"
        }
      }
    );

    if (!deleteRes.ok) {
      const text = await deleteRes.text();
      throw new Error(`Event cleanup failed: ${deleteRes.status} ${text}`);
    }
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/events`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(payloads)
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Event upsert failed: ${res.status} ${text}`);
  }
}

function rentalExtensionCalendarPayloads(record, baseTitle, createdByBase) {
  const eventDate = String(record.event_date || "").slice(0, 10);
  if (!eventDate) return [];

  const previousDate = shiftDateKey(eventDate, -1);
  const nextDate = shiftDateKey(eventDate, 1);
  const extensions = [
    record.addon_early_day_rental && {
      key: "early-day",
      title: `${baseTitle} - Extra Day Early`,
      date: previousDate,
      start: "07:00",
      end: "21:00"
    },
    !record.addon_early_day_rental && record.addon_early_setup && {
      key: "early-setup",
      title: `${baseTitle} - Early Setup`,
      date: previousDate,
      start: "18:00",
      end: "21:00"
    },
    !record.addon_late_day_rental && record.addon_late_cleanup && {
      key: "late-cleanup",
      title: `${baseTitle} - Late Cleanup`,
      date: nextDate,
      start: "07:00",
      end: "09:00"
    },
    record.addon_late_day_rental && {
      key: "late-day",
      title: `${baseTitle} - Extra Day Late`,
      date: nextDate,
      start: "07:00",
      end: "21:00"
    }
  ].filter(Boolean);

  return extensions.map((extension) => ({
    title: extension.title,
    event_type: "rental",
    start_at: buildIsoTimestamp(extension.date, extension.start),
    end_at: buildIsoTimestamp(extension.date, extension.end),
    all_day: false,
    is_public: false,
    status: "confirmed",
    rental_request_id: record.id,
    created_by: `${createdByBase}:calendar:${extension.key}`
  }));
}

function calendarCreatedByBase(value) {
  const markerIndex = String(value || "").indexOf(":calendar:");
  if (markerIndex >= 0) return String(value).slice(0, markerIndex);
  return String(value || "system") || "system";
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return "";
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

async function syncLinkedCalendarEventStatus(rentalRequestId, eventStatus) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/events?rental_request_id=eq.${encodeURIComponent(rentalRequestId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        status: eventStatus,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Event status sync failed: ${res.status} ${text}`);
  }
}

async function runRentalReviewAutomations(record, requestedStatus, adminNotes, options = {}) {
  const warnings = [];

  if (requestedStatus === "confirmed") {
    const calendarWarning = await runAutomation("Calendar event creation", () => createOrUpdateCalendarEvent(record, options));
    if (calendarWarning) warnings.push(calendarWarning);

    const emailWarning = await runAutomation("Rental applicant email", () => sendApplicantEmail(record, requestedStatus, adminNotes, options.req));
    if (emailWarning) warnings.push(emailWarning);
  } else if (requestedStatus === "rejected" || requestedStatus === "canceled") {
    const calendarWarning = await runAutomation("Linked calendar event status sync", () => syncLinkedCalendarEventStatus(record.id, "cancelled"));
    if (calendarWarning) warnings.push(calendarWarning);

    const emailWarning = await runAutomation("Rental applicant email", () => sendApplicantEmail(record, requestedStatus, adminNotes, options.req));
    if (emailWarning) warnings.push(emailWarning);
  } else if (record.rental_status === "confirmed") {
    const calendarWarning = await runAutomation("Linked calendar event update", () => createOrUpdateCalendarEvent(record, options));
    if (calendarWarning) warnings.push(calendarWarning);
  }

  return warnings;
}

async function runAutomation(label, task) {
  try {
    await task();
    return null;
  } catch (err) {
    console.error(`${label} failed:`, err);
    return `${label} failed`;
  }
}

function buildIsoTimestamp(dateStr, hhmm) {
  return facilityWallTimeToIso(dateStr, hhmm || "00:00");
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
  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    return `${String(dateStr || "")}T${String(timeStr || "00:00")}:00`;
  }

  const wallTime = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utcTime = wallTime;
  for (let i = 0; i < 3; i += 1) {
    utcTime = wallTime - getFacilityTimeZoneOffsetMs(new Date(utcTime));
  }
  return new Date(utcTime).toISOString();
}

function buildRentalRecord(body) {
  const publicStart = str(body.public_event_start_time || body.publicEventStartTime);
  const publicEnd = str(body.public_event_end_time || body.publicEventEndTime);
  const rentalType = str(body.rental_type || body.rentalType) === "hourly" ? "hourly" : "all_day";
  const record = {
    contact_name: str(body.contact_name || body.contactName || body.title || "Admin Booking"),
    contact_phone: str(body.contact_phone || body.contactPhone),
    contact_email: str(body.contact_email || body.contactEmail).toLowerCase(),
    contact_address: str(body.contact_address || body.contactAddress),
    event_name: str(body.event_name || body.eventName || body.title) || null,
    event_type: str(body.event_type || body.eventType || "Other") || "Other",
    event_date: str(body.event_date),
    event_start_time: str(body.event_start_time || body.eventStartTime || "07:00") || "07:00",
    event_end_time: str(body.event_end_time || body.eventEndTime || "21:00") || "21:00",
    ...(publicStart && publicEnd ? {
      public_event_start_time: publicStart,
      public_event_end_time: publicEnd
    } : {}),
    estimated_attendance: Math.max(1, Number(body.estimated_attendance ?? body.estimatedAttendance ?? 1) || 1),
    food_or_drinks: Boolean(body.food_or_drinks ?? body.foodOrDrinks),
    alcohol: str(body.alcohol || "No") || "No",
    addon_tables: Boolean(body.addon_tables ?? body.addonTables),
    addon_chairs: Boolean(body.addon_chairs ?? body.addonChairs),
    addon_tarp: Boolean(body.addon_tarp ?? body.addonTarp),
    addon_heater: Boolean(body.addon_heater ?? body.addonHeater),
    addon_ac: Boolean(body.addon_ac ?? body.addonAc),
    addon_cleaning_maintenance: Boolean(body.addon_cleaning_maintenance ?? body.addonCleaningMaintenance),
    addon_early_setup: Boolean(body.addon_early_setup ?? body.addonEarlySetup) && !Boolean(body.addon_early_day_rental ?? body.addonEarlyDayRental),
    addon_early_day_rental: Boolean(body.addon_early_day_rental ?? body.addonEarlyDayRental),
    addon_late_cleanup: Boolean(body.addon_late_cleanup ?? body.addonLateCleanup) && !Boolean(body.addon_late_day_rental ?? body.addonLateDayRental),
    addon_late_day_rental: Boolean(body.addon_late_day_rental ?? body.addonLateDayRental),
    estimated_total_cents: 0,
    is_private_event: bodyFieldValue(body, "is_private_event", "isPrivateEvent") !== false,
    special_access_discount: Boolean(bodyFieldValue(body, "special_access_discount", "specialAccessDiscount")),
    rental_type: rentalType,
    rental_hours: rentalType === "hourly"
      ? normalizeRentalHours(rentalHoursBetween(
        body.event_start_time ?? body.eventStartTime ?? "07:00",
        body.event_end_time ?? body.eventEndTime ?? "21:00",
        1
      ))
      : null,
    agreed_to_no_guarantee: true,
    agreed_to_guidelines: true,
    rental_status: VALID_STATUSES.includes(body.rental_status || body.rentalStatus)
      ? (body.rental_status || body.rentalStatus)
      : "confirmed",
    admin_notes: typeof body.admin_notes === "string"
      ? body.admin_notes.trim() || null
      : typeof body.adminNotes === "string" ? body.adminNotes.trim() || null : null,
    reviewed_at: new Date().toISOString()
  };
  const claimedMemberId = str(body.claimed_member_id || body.claimedMemberId);
  const claimedAccountId = str(body.claimed_account_id || body.claimedAccountId);
  if (isUuid(claimedMemberId)) record.claimed_member_id = claimedMemberId;
  if (isUuid(claimedAccountId)) record.claimed_account_id = claimedAccountId;
  record.estimated_total_cents = calculateRentalTotalCents({
    ...record
  });
  return record;
}

function buildRentalPatch(body, existingRecord = {}) {
  const patch = {};
  const allowedFields = [
    ["contact_name", body.contact_name ?? body.contactName],
    ["contact_phone", body.contact_phone ?? body.contactPhone],
    ["contact_email", body.contact_email ?? body.contactEmail],
    ["contact_address", body.contact_address ?? body.contactAddress],
    ["event_name", body.event_name ?? body.eventName],
    ["event_type", body.event_type ?? body.eventType],
    ["event_date", body.event_date ?? body.eventDate],
    ["event_start_time", body.event_start_time ?? body.eventStartTime],
    ["event_end_time", body.event_end_time ?? body.eventEndTime],
    ["alcohol", body.alcohol]
  ];

  allowedFields.forEach(([key, value]) => {
    if (value !== undefined) patch[key] = key === "contact_email" ? str(value).toLowerCase() : str(value);
  });
  const publicStartProvided = hasBodyField(body, "public_event_start_time") || hasBodyField(body, "publicEventStartTime");
  const publicEndProvided = hasBodyField(body, "public_event_end_time") || hasBodyField(body, "publicEventEndTime");
  if (publicStartProvided || publicEndProvided) {
    const nextPublicStart = str(bodyFieldValue(body, "public_event_start_time", "publicEventStartTime"));
    const nextPublicEnd = str(bodyFieldValue(body, "public_event_end_time", "publicEventEndTime"));
    if (nextPublicStart && nextPublicEnd) {
      patch.public_event_start_time = nextPublicStart;
      patch.public_event_end_time = nextPublicEnd;
    } else {
      patch.public_event_start_time = null;
      patch.public_event_end_time = null;
    }
  }

  if (body.estimated_attendance !== undefined || body.estimatedAttendance !== undefined) {
    patch.estimated_attendance = Math.max(1, Number(body.estimated_attendance ?? body.estimatedAttendance ?? 1) || 1);
  }
  if (body.food_or_drinks !== undefined || body.foodOrDrinks !== undefined) patch.food_or_drinks = Boolean(body.food_or_drinks ?? body.foodOrDrinks);
  if (body.addon_cleaning_maintenance !== undefined || body.addonCleaningMaintenance !== undefined) {
    patch.addon_cleaning_maintenance = Boolean(body.addon_cleaning_maintenance ?? body.addonCleaningMaintenance);
  }
  if (body.addon_tables !== undefined || body.addonTables !== undefined) patch.addon_tables = Boolean(body.addon_tables ?? body.addonTables);
  if (body.addon_chairs !== undefined || body.addonChairs !== undefined) patch.addon_chairs = Boolean(body.addon_chairs ?? body.addonChairs);
  if (body.addon_tarp !== undefined || body.addonTarp !== undefined) patch.addon_tarp = Boolean(body.addon_tarp ?? body.addonTarp);
  if (body.addon_heater !== undefined || body.addonHeater !== undefined) patch.addon_heater = Boolean(body.addon_heater ?? body.addonHeater);
  if (body.addon_ac !== undefined || body.addonAc !== undefined) patch.addon_ac = Boolean(body.addon_ac ?? body.addonAc);
  if (body.addon_early_setup !== undefined || body.addonEarlySetup !== undefined) patch.addon_early_setup = Boolean(body.addon_early_setup ?? body.addonEarlySetup);
  if (body.addon_early_day_rental !== undefined || body.addonEarlyDayRental !== undefined) patch.addon_early_day_rental = Boolean(body.addon_early_day_rental ?? body.addonEarlyDayRental);
  if (patch.addon_early_day_rental) patch.addon_early_setup = false;
  else if (patch.addon_early_setup) patch.addon_early_day_rental = false;
  if (body.addon_late_cleanup !== undefined || body.addonLateCleanup !== undefined) patch.addon_late_cleanup = Boolean(body.addon_late_cleanup ?? body.addonLateCleanup);
  if (body.addon_late_day_rental !== undefined || body.addonLateDayRental !== undefined) patch.addon_late_day_rental = Boolean(body.addon_late_day_rental ?? body.addonLateDayRental);
  if (patch.addon_late_day_rental) patch.addon_late_cleanup = false;
  else if (patch.addon_late_cleanup) patch.addon_late_day_rental = false;
  if (hasBodyField(body, "is_private_event") || hasBodyField(body, "isPrivateEvent")) {
    patch.is_private_event = bodyFieldValue(body, "is_private_event", "isPrivateEvent") !== false;
  }
  if (hasBodyField(body, "special_access_discount") || hasBodyField(body, "specialAccessDiscount")) {
    patch.special_access_discount = Boolean(bodyFieldValue(body, "special_access_discount", "specialAccessDiscount"));
  }
  if (hasBodyField(body, "claimed_member_id") || hasBodyField(body, "claimedMemberId")) {
    const value = str(bodyFieldValue(body, "claimed_member_id", "claimedMemberId"));
    patch.claimed_member_id = isUuid(value) ? value : null;
    patch.claimed_at = patch.claimed_member_id ? new Date().toISOString() : null;
  }
  if (hasBodyField(body, "claimed_account_id") || hasBodyField(body, "claimedAccountId")) {
    const value = str(bodyFieldValue(body, "claimed_account_id", "claimedAccountId"));
    patch.claimed_account_id = isUuid(value) ? value : null;
  }

  if (body.rental_type !== undefined || body.rentalType !== undefined) {
    patch.rental_type = str(body.rental_type || body.rentalType) === "hourly" ? "hourly" : "all_day";
    patch.rental_hours = patch.rental_type === "hourly"
      ? normalizeRentalHours(rentalHoursBetween(
        patch.event_start_time ?? body.event_start_time ?? body.eventStartTime ?? "07:00",
        patch.event_end_time ?? body.event_end_time ?? body.eventEndTime ?? "21:00",
        body.rental_hours ?? body.rentalHours ?? 1
      ))
      : null;
  }
  if (body.estimated_total_cents !== undefined || body.estimatedTotalCents !== undefined) {
    patch.estimated_total_cents = calculateRentalTotalCents(rentalPricingRecordFromBody(body, patch, existingRecord));
  }

  if (body.status !== undefined) patch.rental_status = body.status;
  if (hasBodyField(body, "adminNotes") || hasBodyField(body, "admin_notes")) {
    patch.admin_notes = str(bodyFieldValue(body, "admin_notes", "adminNotes")) || null;
  }
  patch.reviewed_at = new Date().toISOString();
  return patch;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function str(value) {
  return String(value || "").trim();
}

function rentalPricingRecordFromBody(body, patch = {}, existingRecord = {}) {
  const rentalType = patch.rental_type || (str(body.rental_type || body.rentalType) === "hourly" ? "hourly" : "all_day");
  return {
    event_start_time: patch.event_start_time || str(body.event_start_time || body.eventStartTime || "07:00") || "07:00",
    event_end_time: patch.event_end_time || str(body.event_end_time || body.eventEndTime || "21:00") || "21:00",
    rental_type: rentalType,
    rental_hours: rentalType === "hourly"
      ? normalizeRentalHours(rentalHoursBetween(
        patch.event_start_time || str(body.event_start_time || body.eventStartTime || "07:00") || "07:00",
        patch.event_end_time || str(body.event_end_time || body.eventEndTime || "21:00") || "21:00",
        patch.rental_hours ?? body.rental_hours ?? body.rentalHours ?? 1
      ))
      : null,
    is_private_event: hasBodyField(patch, "is_private_event")
      ? patch.is_private_event
      : bodyFieldValue(body, "is_private_event", "isPrivateEvent") !== false,
    special_access_discount: hasBodyField(patch, "special_access_discount")
      ? patch.special_access_discount
      : hasBodyField(body, "special_access_discount") || hasBodyField(body, "specialAccessDiscount")
        ? Boolean(bodyFieldValue(body, "special_access_discount", "specialAccessDiscount"))
        : Boolean(existingRecord.special_access_discount),
    addon_cleaning_maintenance: patch.addon_cleaning_maintenance ?? Boolean(body.addon_cleaning_maintenance ?? body.addonCleaningMaintenance),
    addon_tables: patch.addon_tables ?? Boolean(body.addon_tables ?? body.addonTables),
    addon_chairs: patch.addon_chairs ?? Boolean(body.addon_chairs ?? body.addonChairs),
    addon_tarp: patch.addon_tarp ?? Boolean(body.addon_tarp ?? body.addonTarp),
    addon_early_setup: patch.addon_early_setup ?? Boolean(body.addon_early_setup ?? body.addonEarlySetup),
    addon_early_day_rental: patch.addon_early_day_rental ?? Boolean(body.addon_early_day_rental ?? body.addonEarlyDayRental),
    addon_late_cleanup: patch.addon_late_cleanup ?? Boolean(body.addon_late_cleanup ?? body.addonLateCleanup),
    addon_late_day_rental: patch.addon_late_day_rental ?? Boolean(body.addon_late_day_rental ?? body.addonLateDayRental)
  };
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
    total = Math.round(
      normalizeRentalHours(rentalHoursBetween(record?.event_start_time, record?.event_end_time, record?.rental_hours || 1))
      * RENTAL_PRICE_CENTS.privateHourly
    );
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
  if (start === null || end === null) return `${label} start/end time must be valid`;
  if (end <= start) return `${label} end time must be after start time`;
  return "";
}

function hasBodyField(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

function bodyFieldValue(body, snakeKey, camelKey) {
  if (hasBodyField(body, snakeKey)) return body[snakeKey];
  if (hasBodyField(body, camelKey)) return body[camelKey];
  return undefined;
}

function calendarPublicOverrideFromBody(body) {
  const provided = hasBodyField(body, "calendar_is_public") || hasBodyField(body, "calendarIsPublic");
  return {
    provided,
    value: provided ? Boolean(bodyFieldValue(body, "calendar_is_public", "calendarIsPublic")) : undefined
  };
}

function mapRow(row, linkedEvent = null, changeRequests = []) {
  return {
    id: row.id,
    bookingNumber: row.booking_number || "",
    eventName: row.event_name,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    contactAddress: row.contact_address,
    eventType: row.event_type,
    eventDate: row.event_date,
    eventStartTime: row.event_start_time,
    eventEndTime: row.event_end_time,
    publicEventStartTime: row.public_event_start_time,
    publicEventEndTime: row.public_event_end_time,
    estimatedAttendance: row.estimated_attendance,
    foodOrDrinks: row.food_or_drinks,
    alcohol: row.alcohol,
    addonCleaningMaintenance: row.addon_cleaning_maintenance,
    addonTables: row.addon_tables,
    addonChairs: row.addon_chairs,
    addonTarp: row.addon_tarp,
    addonHeater: row.addon_heater,
    addonAc: row.addon_ac,
    addonEarlySetup: row.addon_early_setup,
    addonEarlyDayRental: row.addon_early_day_rental,
    addonLateCleanup: row.addon_late_cleanup,
    addonLateDayRental: row.addon_late_day_rental,
    estimatedTotalCents: row.estimated_total_cents,
    isPrivateEvent: row.is_private_event !== false,
    specialAccessDiscount: Boolean(row.special_access_discount),
    rentalType: row.rental_type,
    rentalHours: row.rental_hours,
    rentalStatus: row.rental_status,
    adminNotes: row.admin_notes,
    claimedAccountId: row.claimed_account_id || null,
    claimedMemberId: row.claimed_member_id || null,
    claimedAt: row.claimed_at || null,
    claimExpiresAt: row.claim_token_expires_at || null,
    linkedCalendarEventId: linkedEvent?.id || null,
    calendarIsPublic: Boolean(linkedEvent?.is_public),
    changeRequests: (changeRequests || []).map(mapRentalChangeRequest),
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at
  };
}

function mapRentalChangeRequest(row) {
  const payload = row?.requested_payload || {};
  const snapshot = row?.requester_snapshot || {};
  return {
    id: row.id,
    rentalRequestId: row.rental_request_id,
    requesterMemberId: row.requester_member_id,
    requestType: row.request_type,
    status: row.status,
    requestedPayload: payload,
    requesterSnapshot: snapshot,
    reviewNotes: row.review_notes,
    reviewedByMemberId: row.reviewed_by_member_id,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
  if (!response.ok) throw new Error("Invalid session");
  return response.json();
}

async function getAccountMember(authUserId) {
  const rows = await supabaseRest(
    `account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
  );
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

async function loadLinkedCalendarEventMap(rentalIds = []) {
  const ids = [...new Set((rentalIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  const rows = await supabaseRest(
    `events?select=id,rental_request_id,is_public,status,created_by&rental_request_id=in.(${ids.map(encodeURIComponent).join(",")})&status=neq.cancelled`
  );
  const byRentalId = new Map();
  (rows || []).forEach((event) => {
    if (!event.rental_request_id) return;
    const current = byRentalId.get(event.rental_request_id);
    const isMain = String(event.created_by || "").includes(":calendar:main");
    if (!current || isMain) {
      byRentalId.set(event.rental_request_id, event);
    }
  });
  return byRentalId;
}

async function loadRentalChangeRequestsMap(rentalIds = []) {
  const ids = [...new Set((rentalIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  try {
    const rows = await supabaseRest(
      `rental_change_requests?select=*&rental_request_id=in.(${ids.map(encodeURIComponent).join(",")})&order=created_at.desc&limit=500`
    );
    const byRentalId = new Map();
    (rows || []).forEach((request) => {
      if (!request.rental_request_id) return;
      const list = byRentalId.get(request.rental_request_id) || [];
      list.push(request);
      byRentalId.set(request.rental_request_id, list);
    });
    return byRentalId;
  } catch (error) {
    console.warn("Rental change requests unavailable:", error?.message || error);
    return new Map();
  }
}

async function loadRentalChangeRequestById(id) {
  const rows = await supabaseRest(`rental_change_requests?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows[0] || null;
}

async function loadRentalRequestById(id) {
  const rows = await supabaseRest(`rental_requests?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows[0] || null;
}

async function reviewRentalChangeRequest({ changeRequestId, action, reviewNotes, manager, req }) {
  const request = await loadRentalChangeRequestById(changeRequestId);
  if (!request) throw httpError(404, "Renter request not found");
  if (request.status !== "pending") throw httpError(409, "This renter request has already been reviewed");

  const now = new Date().toISOString();
  const normalizedAction = String(action || "").trim();
  const notes = str(reviewNotes);

  if (normalizedAction === "reject") {
    await supabaseWrite(
      `rental_change_requests?id=eq.${encodeURIComponent(changeRequestId)}`,
      "PATCH",
      {
        status: "rejected",
        review_notes: notes || null,
        reviewed_by_member_id: manager?.id || null,
        reviewed_at: now
      }
    );
    const rental = await loadRentalRequestById(request.rental_request_id);
    const linkedEvents = rental ? await loadLinkedCalendarEventMap([rental.id]) : new Map();
    const changes = rental ? await loadRentalChangeRequestsMap([rental.id]) : new Map();
    return {
      success: true,
      request: rental ? mapRow(rental, linkedEvents.get(rental.id), changes.get(rental.id) || []) : null,
      automationWarnings: []
    };
  }

  const rental = await loadRentalRequestById(request.rental_request_id);
  if (!rental) throw httpError(404, "Rental request not found");

  let updatedRental = rental;
  const automationWarnings = [];

  if (request.request_type === "cancel") {
    const rows = await supabaseWrite(
      `rental_requests?id=eq.${encodeURIComponent(rental.id)}`,
      "PATCH",
      {
        rental_status: "canceled",
        admin_notes: notes || rental.admin_notes || null,
        reviewed_at: now
      }
    );
    updatedRental = rows[0] || rental;
    automationWarnings.push(...await runRentalReviewAutomations(updatedRental, "canceled", notes, { req }));
  } else {
    const patch = buildRentalPatch(request.requested_payload || {});
    const merged = { ...rental, ...patch };
    if (merged.rental_type === "hourly") {
      patch.rental_hours = rentalHoursBetween(merged.event_start_time, merged.event_end_time, merged.rental_hours || 1);
      merged.rental_hours = patch.rental_hours;
    } else {
      patch.rental_hours = null;
      merged.rental_hours = null;
    }
    patch.estimated_total_cents = calculateRentalTotalCents(merged);
    patch.reviewed_at = now;
    const rows = await supabaseWrite(
      `rental_requests?id=eq.${encodeURIComponent(rental.id)}`,
      "PATCH",
      patch
    );
    updatedRental = rows[0] || rental;
    automationWarnings.push(...await runRentalReviewAutomations(updatedRental, updatedRental.rental_status, notes, { req }));
  }

  await supabaseWrite(
    `rental_change_requests?id=eq.${encodeURIComponent(changeRequestId)}`,
    "PATCH",
    {
      status: "approved",
      review_notes: notes || null,
      reviewed_by_member_id: manager?.id || null,
      reviewed_at: now
    }
  );

  const [linkedEvents, changeRequests] = await Promise.all([
    loadLinkedCalendarEventMap([updatedRental.id]),
    loadRentalChangeRequestsMap([updatedRental.id])
  ]);

  return {
    success: true,
    request: mapRow(updatedRental, linkedEvents.get(updatedRental.id), changeRequests.get(updatedRental.id) || []),
    automationWarnings
  };
}

async function sendApplicantEmail(record, status, adminNotes, req) {
  if (!RESEND_API_KEY) {
    console.warn("Rental applicant email skipped: RESEND_API_KEY is not configured.");
    return null;
  }
  if (!record?.contact_email) {
    console.warn("Rental applicant email skipped: contact_email is missing.");
    return null;
  }

  let emailRecord = record;
  let manageUrl = "";
  if (status === "confirmed") {
    try {
      const claim = await prepareRentalClaimLink(record, req);
      emailRecord = claim.record || record;
      manageUrl = claim.manageUrl || "";
    } catch (error) {
      console.warn("Rental claim link generation failed:", error?.message || error);
    }
  }

  const email = buildRentalApplicantEmail({ record: emailRecord, status, adminNotes, manageUrl });

  const responseBody = await sendResendEmail({
    apiKey: RESEND_API_KEY,
    from: RESEND_FROM_EMAIL,
    to: [record.contact_email],
    subject: email.subject,
    text: email.text,
    html: email.html,
    idempotencyKey: `rental-applicant-${record.id}-${status || "update"}-${String(emailRecord.claim_token_hash || emailRecord.reviewed_at || "").slice(0, 24)}`
  });

  console.info(`Rental applicant email sent to ${record.contact_email}.`, responseBody?.id ? `Resend id: ${responseBody.id}` : "");
  return responseBody;
}

async function prepareRentalClaimLink(record, req) {
  if (!record?.id) return { record, manageUrl: "" };
  if (record.claimed_member_id) {
    return {
      record,
      manageUrl: `${siteOrigin(req)}/member-dashboard/?booking=${encodeURIComponent(record.booking_number || record.id)}`
    };
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CLAIM_LINK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await supabaseWrite(
    `rental_requests?id=eq.${encodeURIComponent(record.id)}`,
    "PATCH",
    {
      claim_token_hash: hashToken(token),
      claim_token_expires_at: expiresAt
    }
  );
  const nextRecord = rows[0] || { ...record, claim_token_expires_at: expiresAt };
  return {
    record: nextRecord,
    manageUrl: `${siteOrigin(req)}/rental-account/?token=${encodeURIComponent(token)}`
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function siteOrigin(req) {
  const configured = PUBLIC_SITE_URL;
  if (configured) return configured;
  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host || "";
  const proto = req?.headers?.["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "https://ruthobenchainrc.com";
}

async function supabaseWrite(path, method, payload) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST write failed: ${response.status} ${text}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
