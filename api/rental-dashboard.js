const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!SERVICE_ROLE_KEY) return res.status(500).json({ success: false, error: "Server configuration error" });

  let member;
  try {
    const user = await getSupabaseUser(bearerToken(req));
    member = await getAccountMember(user.id);
    if (!member) throw httpError(403, "This session is not linked to a member.");
  } catch (error) {
    return res.status(Number(error.statusCode) || 401).json({ success: false, error: error.message || "Invalid session" });
  }

  try {
    if (req.method === "GET") {
      const rentals = await loadMemberRentals(member);
      const changeRequests = await loadChangeRequestsForRentals(rentals.map((rental) => rental.id), member.id);
      return res.status(200).json({
        success: true,
        member: mapMember(member),
        bookings: rentals.map((rental) => mapRental(rental, changeRequests.get(rental.id) || []))
      });
    }

    if (req.method === "POST") {
      const rentalRequestId = String(req.body?.rentalRequestId || req.body?.rental_request_id || "").trim();
      const requestType = String(req.body?.requestType || req.body?.request_type || "").trim();
      if (!rentalRequestId) return res.status(400).json({ success: false, error: "Booking is required." });
      if (!["update", "cancel"].includes(requestType)) {
        return res.status(400).json({ success: false, error: "Request type must be update or cancel." });
      }

      const rental = await loadMemberRentalById(member, rentalRequestId);
      if (!rental) return res.status(404).json({ success: false, error: "Booking not found." });

      await cancelPendingChangeRequests(rental.id, member.id);
      const payload = requestType === "cancel"
        ? { message: stringValue(req.body?.message || req.body?.notes) }
        : sanitizeRequestedPayload(req.body?.requestedPayload || req.body?.requested_payload || {});

      const rows = await supabaseWrite("rental_change_requests", "POST", {
        rental_request_id: rental.id,
        requester_member_id: member.id,
        request_type: requestType,
        status: "pending",
        requested_payload: payload,
        requester_snapshot: {
          memberId: member.id,
          accountId: member.account_id,
          name: member.member_name,
          email: member.email_address,
          phone: member.phone_number,
          accountType: member.account_type,
          submittedAt: new Date().toISOString()
        }
      });

      return res.status(200).json({ success: true, changeRequest: mapChangeRequest(rows[0]) });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message || "Could not load booking dashboard" });
  }
};

async function loadMemberRentals(member) {
  const email = normalizeEmail(member.email_address);
  const filters = [`claimed_member_id.eq.${encodeURIComponent(member.id)}`];
  if (email) filters.push(`contact_email.eq.${encodeURIComponent(email)}`);
  return supabaseRest(
    `rental_requests?select=*&or=(${filters.join(",")})&order=event_date.asc&order=created_at.asc&limit=200`
  );
}

async function loadMemberRentalById(member, rentalRequestId) {
  const rows = await supabaseRest(
    `rental_requests?select=*&id=eq.${encodeURIComponent(rentalRequestId)}&limit=1`
  );
  const rental = rows[0] || null;
  if (!rental) return null;
  const memberEmail = normalizeEmail(member.email_address);
  const rentalEmail = normalizeEmail(rental.contact_email);
  if (String(rental.claimed_member_id || "") === String(member.id)) return rental;
  if (memberEmail && rentalEmail && memberEmail === rentalEmail) return rental;
  return null;
}

async function loadChangeRequestsForRentals(rentalIds, memberId) {
  const ids = [...new Set((rentalIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const rows = await supabaseRest(
    `rental_change_requests?select=*&rental_request_id=in.(${ids.map(encodeURIComponent).join(",")})&requester_member_id=eq.${encodeURIComponent(memberId)}&order=created_at.desc&limit=500`
  ).catch(() => []);
  const map = new Map();
  (rows || []).forEach((row) => {
    const list = map.get(row.rental_request_id) || [];
    list.push(row);
    map.set(row.rental_request_id, list);
  });
  return map;
}

async function cancelPendingChangeRequests(rentalId, memberId) {
  await supabaseWrite(
    `rental_change_requests?rental_request_id=eq.${encodeURIComponent(rentalId)}&requester_member_id=eq.${encodeURIComponent(memberId)}&status=eq.pending`,
    "PATCH",
    { status: "canceled" }
  ).catch(() => []);
}

function sanitizeRequestedPayload(raw) {
  const payload = {};
  const textFields = [
    ["contact_name", raw.contact_name ?? raw.contactName],
    ["contact_phone", raw.contact_phone ?? raw.contactPhone],
    ["contact_email", raw.contact_email ?? raw.contactEmail],
    ["contact_address", raw.contact_address ?? raw.contactAddress],
    ["event_name", raw.event_name ?? raw.eventName],
    ["event_type", raw.event_type ?? raw.eventType],
    ["event_date", raw.event_date ?? raw.eventDate],
    ["event_start_time", raw.event_start_time ?? raw.eventStartTime],
    ["event_end_time", raw.event_end_time ?? raw.eventEndTime],
    ["public_event_start_time", raw.public_event_start_time ?? raw.publicEventStartTime],
    ["public_event_end_time", raw.public_event_end_time ?? raw.publicEventEndTime],
    ["alcohol", raw.alcohol],
    ["adminNotes", raw.adminNotes ?? raw.message ?? raw.notes]
  ];

  textFields.forEach(([key, value]) => {
    if (value !== undefined) payload[key] = stringValue(value);
  });

  [
    ["food_or_drinks", raw.food_or_drinks ?? raw.foodOrDrinks],
    ["addon_tables", raw.addon_tables ?? raw.addonTables],
    ["addon_chairs", raw.addon_chairs ?? raw.addonChairs],
    ["addon_cleaning_maintenance", raw.addon_cleaning_maintenance ?? raw.addonCleaningMaintenance],
    ["addon_tarp", raw.addon_tarp ?? raw.addonTarp],
    ["addon_heater", raw.addon_heater ?? raw.addonHeater],
    ["addon_ac", raw.addon_ac ?? raw.addonAc],
    ["addon_early_setup", raw.addon_early_setup ?? raw.addonEarlySetup],
    ["addon_early_day_rental", raw.addon_early_day_rental ?? raw.addonEarlyDayRental],
    ["addon_late_cleanup", raw.addon_late_cleanup ?? raw.addonLateCleanup],
    ["addon_late_day_rental", raw.addon_late_day_rental ?? raw.addonLateDayRental],
    ["is_private_event", raw.is_private_event ?? raw.isPrivateEvent]
  ].forEach(([key, value]) => {
    if (value !== undefined) payload[key] = Boolean(value);
  });

  if (raw.estimated_attendance !== undefined || raw.estimatedAttendance !== undefined) {
    payload.estimated_attendance = Math.max(1, Number(raw.estimated_attendance ?? raw.estimatedAttendance ?? 1) || 1);
  }
  if (raw.rental_type !== undefined || raw.rentalType !== undefined) {
    payload.rental_type = stringValue(raw.rental_type ?? raw.rentalType) === "hourly" ? "hourly" : "all_day";
  }
  if (raw.rental_hours !== undefined || raw.rentalHours !== undefined) {
    const rawHours = raw.rental_hours ?? raw.rentalHours;
    if (rawHours !== null && rawHours !== "") {
      const hours = Number(rawHours);
      payload.rental_hours = Number.isFinite(hours) && hours > 0 ? Math.min(24, Math.round(hours * 100) / 100) : 1;
    }
  }
  return payload;
}

async function getSupabaseUser(token) {
  if (!token) throw httpError(401, "Missing session token");
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) throw httpError(401, "Invalid session");
  return response.json();
}

async function getAccountMember(authUserId) {
  const rows = await supabaseRest(
    `account_members?select=id,account_id,member_name,account_type,email_address,phone_number,is_billing_owner&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
  );
  return rows[0] || null;
}

function mapMember(member) {
  return {
    id: member.id,
    accountId: member.account_id,
    memberName: member.member_name,
    accountType: member.account_type,
    emailAddress: member.email_address,
    phoneNumber: member.phone_number,
    isBillingOwner: Boolean(member.is_billing_owner)
  };
}

function mapRental(row, changeRequests = []) {
  return {
    id: row.id,
    bookingNumber: row.booking_number || "",
    rentalStatus: row.rental_status || "",
    contactName: row.contact_name || "",
    contactPhone: row.contact_phone || "",
    contactEmail: row.contact_email || "",
    contactAddress: row.contact_address || "",
    eventName: row.event_name || "",
    eventType: row.event_type || "",
    eventDate: row.event_date || "",
    eventStartTime: row.event_start_time || "",
    eventEndTime: row.event_end_time || "",
    publicEventStartTime: row.public_event_start_time || "",
    publicEventEndTime: row.public_event_end_time || "",
    estimatedAttendance: row.estimated_attendance || null,
    foodOrDrinks: Boolean(row.food_or_drinks),
    alcohol: row.alcohol || "No",
    addonCleaningMaintenance: Boolean(row.addon_cleaning_maintenance),
    addonTables: Boolean(row.addon_tables),
    addonChairs: Boolean(row.addon_chairs),
    addonTarp: Boolean(row.addon_tarp),
    addonHeater: Boolean(row.addon_heater),
    addonAc: Boolean(row.addon_ac),
    addonEarlySetup: Boolean(row.addon_early_setup),
    addonEarlyDayRental: Boolean(row.addon_early_day_rental),
    addonLateCleanup: Boolean(row.addon_late_cleanup),
    addonLateDayRental: Boolean(row.addon_late_day_rental),
    estimatedTotalCents: Number(row.estimated_total_cents || 0),
    isPrivateEvent: row.is_private_event !== false,
    specialAccessDiscount: Boolean(row.special_access_discount),
    rentalType: row.rental_type || "",
    rentalHours: row.rental_hours || null,
    adminNotes: row.admin_notes || "",
    claimedAt: row.claimed_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    changeRequests: (changeRequests || []).map(mapChangeRequest)
  };
}

function mapChangeRequest(row) {
  return {
    id: row.id,
    rentalRequestId: row.rental_request_id,
    requesterMemberId: row.requester_member_id,
    requestType: row.request_type,
    status: row.status,
    requestedPayload: row.requested_payload || {},
    requesterSnapshot: row.requester_snapshot || {},
    reviewNotes: row.review_notes || "",
    reviewedAt: row.reviewed_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

async function supabaseRest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: supabaseHeaders({ contentType: false })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase REST failed: ${response.status} ${text}`);
  }
  return response.json();
}

async function supabaseWrite(path, method, payload) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: supabaseHeaders({ prefer: "return=representation" }),
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase write failed: ${response.status} ${text}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

function supabaseHeaders({ prefer = "", contentType = true } = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    ...(contentType ? { "Content-Type": "application/json" } : {}),
    ...(prefer ? { Prefer: prefer } : {})
  };
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function stringValue(value) {
  return String(value ?? "").trim();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
