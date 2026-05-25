const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_TYPES   = ["rental", "maintenance", "rorc"];
const DB_EVENT_TYPES = ["rental", "maintenance", "open_gym", "private_event", "public_event", "general"];
const VALID_STATUSES = ["confirmed", "cancelled"];
const RENTAL_BLOCKING_TYPES = ["rental", "maintenance"];
const FACILITY_TIME_ZONE = "America/Los_Angeles";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!SERVICE_ROLE_KEY) return res.status(500).json({ success: false, error: "Server configuration error" });

  // --- GET: public (no auth) or all (admin) ---
  if (req.method === "GET") {
    const isAdmin = await tryAuth(req);
    const bookedOnly = req.query.booked === "true";

    try {
      let path;

      if (bookedOnly) {
        // Return full-day blocks plus partial time blocks for public rental availability.
        path = `events?select=start_at,end_at,event_type,all_day,rental_requests(event_date,event_start_time,event_end_time,rental_type)&event_type=in.(${RENTAL_BLOCKING_TYPES.join(",")})&status=eq.confirmed&order=start_at.asc`;
        const rows = await supabaseRest(path);
        const availability = collectRentalAvailabilityBlocks(rows);
        return res.status(200).json({ success: true, dates: availability.dates, blocks: availability.blocks });
      }

      if (isAdmin) {
        path = "events?select=*,rental_requests(event_date,event_start_time,event_end_time,rental_type)&order=start_at.asc&limit=500";
      } else {
        path = "events?select=*&is_public=eq.true&status=eq.confirmed&order=start_at.asc&limit=200";
      }

      const [rows, calendarSettings, facilityBlocks] = await Promise.all([
        supabaseRest(path),
        loadCalendarSettings(),
        isAdmin ? Promise.resolve([]) : loadFacilityBlocks()
      ]);
      return res.status(200).json({
        success: true,
        events: rows.map(mapEvent),
        facilityHours: calendarSettings,
        facilityBlocks
      });
    } catch (err) {
      console.error("events GET error:", err);
      return res.status(500).json({ success: false, error: "Could not load events" });
    }
  }

  // All write methods require admin auth
  const authed = await tryAuth(req);
  if (!authed) return res.status(401).json({ success: false, error: "Admin access required" });

  // --- POST: create event ---
  if (req.method === "POST") {
    const body = req.body || {};
    const errors = validateBody(body);
    if (errors.length) return res.status(400).json({ success: false, errors });

    try {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/events`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(buildInsert(body))
      });

      if (!insertRes.ok) {
        const text = await insertRes.text();
        throw new Error(`Insert failed: ${insertRes.status} ${text}`);
      }

      const rows = await insertRes.json();
      return res.status(200).json({ success: true, event: mapEvent(rows[0]) });
    } catch (err) {
      console.error("events POST error:", err);
      return res.status(500).json({ success: false, error: err.message || "Could not create event" });
    }
  }

  // --- PATCH: update event ---
  if (req.method === "PATCH") {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: "Missing event ID" });

    const patch = {};
    if (fields.title       !== undefined) patch.title       = String(fields.title || "").trim().slice(0, 200);
    if (fields.description !== undefined) patch.description = String(fields.description || "").trim() || null;
    if (fields.event_type  !== undefined) patch.event_type = canonicalDbEventType(fields.event_type);
    if (fields.start_at    !== undefined) patch.start_at    = fields.start_at;
    if (fields.end_at      !== undefined) patch.end_at      = fields.end_at;
    if (fields.all_day     !== undefined) patch.all_day     = Boolean(fields.all_day);
    if (fields.is_public   !== undefined) patch.is_public   = Boolean(fields.is_public);
    if (fields.status      !== undefined && VALID_STATUSES.includes(fields.status)) patch.status = fields.status;
    if (fields.rental_request_id !== undefined) patch.rental_request_id = fields.rental_request_id || null;
    if (fields.created_by  !== undefined) patch.created_by  = String(fields.created_by || "admin").trim();
    patch.updated_at = new Date().toISOString();

    try {
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/events?id=eq.${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify(patch)
        }
      );

      if (!patchRes.ok) {
        const text = await patchRes.text();
        throw new Error(`PATCH failed: ${patchRes.status} ${text}`);
      }

      const rows = await patchRes.json();
      return res.status(200).json({ success: true, event: mapEvent(rows[0]) });
    } catch (err) {
      console.error("events PATCH error:", err);
      return res.status(500).json({ success: false, error: "Could not update event" });
    }
  }

  // --- DELETE: remove event ---
  if (req.method === "DELETE") {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: "Missing event ID" });

    try {
      const delRes = await fetch(
        `${SUPABASE_URL}/rest/v1/events?id=eq.${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`
          }
        }
      );

      if (!delRes.ok) {
        const text = await delRes.text();
        throw new Error(`DELETE failed: ${delRes.status} ${text}`);
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("events DELETE error:", err);
      return res.status(500).json({ success: false, error: "Could not delete event" });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
};

function validateBody(body) {
  const errors = [];
  if (!String(body.title || "").trim()) errors.push("Title is required.");
  if (!DB_EVENT_TYPES.includes(canonicalDbEventType(body.event_type))) errors.push("Invalid event type.");
  if (!body.start_at || isNaN(Date.parse(body.start_at))) errors.push("Valid start date/time is required.");
  if (!body.end_at   || isNaN(Date.parse(body.end_at)))   errors.push("Valid end date/time is required.");
  if (new Date(body.start_at) >= new Date(body.end_at))   errors.push("End must be after start.");
  return errors;
}

function buildInsert(body) {
  return {
    title:       String(body.title || "").trim().slice(0, 200),
    description: String(body.description || "").trim() || null,
    event_type:  canonicalDbEventType(body.event_type),
    start_at:    body.start_at,
    end_at:      body.end_at,
    all_day:     Boolean(body.all_day),
    is_public:   Boolean(body.is_public),
    status:      VALID_STATUSES.includes(body.status) ? body.status : "confirmed",
    rental_request_id: body.rental_request_id || null,
    created_by:  String(body.created_by || "admin").trim()
  };
}

function canonicalDbEventType(value) {
  const raw = String(value || "").trim();
  if (raw === "rorc") return "public_event";
  if (DB_EVENT_TYPES.includes(raw)) return raw;
  return "public_event";
}

function mapEvent(row) {
  if (!row) return null;
  const normalizedType = normalizeEventType(row.event_type);
  const createdBy = String(row.created_by || "");
  const seriesMatch = createdBy.match(/^series:([a-zA-Z0-9_-]+)/);
  const detailOnly = /(^|[:;|])detail(?:$|[:;|])/.test(createdBy);
  const rentalTiming = row.rental_requests || null;
  const rentalAccessStartAt = buildLocalDateTime(rentalTiming?.event_date, rentalTiming?.event_start_time);
  const rentalAccessEndAt = buildLocalDateTime(rentalTiming?.event_date, rentalTiming?.event_end_time);
  return {
    id:               row.id,
    title:            row.title,
    description:      row.description,
    eventType:        normalizedType,
    startAt:          row.start_at,
    endAt:            row.end_at,
    allDay:           row.all_day,
    isPublic:         row.is_public,
    status:           row.status,
    rentalRequestId:  row.rental_request_id,
    rentalAccessStartAt,
    rentalAccessEndAt,
    createdBy:        row.created_by,
    detailOnly,
    isRecurring:      Boolean(seriesMatch),
    recurringSeriesId: seriesMatch ? seriesMatch[1] : "",
    createdAt:        row.created_at,
    updatedAt:        row.updated_at
  };
}

function normalizeEventType(value) {
  const raw = String(value || "").trim();
  if (VALID_TYPES.includes(raw)) return raw;
  if (raw === "open_gym" || raw === "private_event" || raw === "public_event" || raw === "general") {
    return "rorc";
  }
  return "rorc";
}

function collectBlockedDates(rows) {
  const blocked = new Set();
  (rows || []).forEach((row) => {
    const startKey = row.all_day ? rawDateKey(row.start_at) : facilityDateKey(row.start_at);
    const endKey = facilityDateKey(row.end_at);
    if (!startKey || !endKey) return;

    const cursor = parseDateKeyAsUtcNoon(startKey);
    const endDay = parseDateKeyAsUtcNoon(endKey);

    while (cursor <= endDay) {
      blocked.add(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  });
  return blocked;
}

function collectRentalAvailabilityBlocks(rows) {
  const blockedDates = new Set();
  const partialBlocks = [];

  (rows || []).forEach((row) => {
    const rentalTiming = row.rental_requests || null;
    const rentalDate = String(rentalTiming?.event_date || "").slice(0, 10);
    const rentalStart = normalizeHourValue(rentalTiming?.event_start_time, "");
    const rentalEnd = normalizeHourValue(rentalTiming?.event_end_time, "");
    const isFullDayRental = normalizeEventType(row.event_type) === "rental" && rentalTiming?.rental_type !== "hourly";

    if (rentalDate && isFullDayRental) {
      blockedDates.add(rentalDate);
      return;
    }

    if (rentalDate && rentalStart && rentalEnd) {
      partialBlocks.push({ date: rentalDate, start: rentalStart, end: rentalEnd, eventType: normalizeEventType(row.event_type) });
      return;
    }

    if (row.all_day) {
      const startKey = rawDateKey(row.start_at);
      const endKey = facilityDateKey(row.end_at);
      if (!startKey || !endKey) return;
      const cursor = parseDateKeyAsUtcNoon(startKey);
      const endDay = parseDateKeyAsUtcNoon(endKey);
      while (cursor <= endDay) {
        blockedDates.add(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return;
    }

    const dateKey = facilityDateKey(row.start_at);
    const start = facilityTimeValue(row.start_at);
    const end = facilityTimeValue(row.end_at);
    if (dateKey && start && end) {
      partialBlocks.push({ date: dateKey, start, end, eventType: normalizeEventType(row.event_type) });
    }
  });

  return {
    dates: [...blockedDates].sort(),
    blocks: partialBlocks.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
  };
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

function rawDateKey(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
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

function parseDateKeyAsUtcNoon(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

// Returns the authed member if admin, null otherwise — never throws
async function tryAuth(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match  = String(header).match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();

  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) return null;
    const user = await userRes.json();

    const rows = await supabaseRest(
      `account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(user.id)}&limit=1`
    );
    const member = rows[0];
    return member?.account_type === "Account Manager" ? member : null;
  } catch {
    return null;
  }
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

async function loadCalendarSettings() {
  try {
    const rows = await supabaseRest("automation_settings?select=config&id=eq.calendar_settings&limit=1");
    const config = rows[0]?.config || {};
    return {
      facility_start: normalizeHourValue(config.facility_start || config.start, "07:00"),
      facility_end: normalizeHourValue(config.facility_end || config.end, "21:00"),
      overrides: normalizeFacilityHourOverrides(config.overrides || {})
    };
  } catch {
    return { facility_start: "07:00", facility_end: "21:00", overrides: {} };
  }
}

async function loadFacilityBlocks() {
  const rows = await supabaseRest(
    `events?select=start_at,end_at,event_type,all_day,rental_requests(event_date,event_start_time,event_end_time,rental_type)&event_type=in.(${RENTAL_BLOCKING_TYPES.join(",")})&status=eq.confirmed&order=start_at.asc&limit=500`
  );
  return (rows || []).map((row) => {
    const rentalTiming = row.rental_requests || null;
    return {
      startAt: buildLocalDateTime(rentalTiming?.event_date, rentalTiming?.event_start_time) || row.start_at,
      endAt: buildLocalDateTime(rentalTiming?.event_date, rentalTiming?.event_end_time) || row.end_at,
      eventType: normalizeEventType(row.event_type),
      allDay: Boolean(row.all_day && !rentalTiming)
    };
  });
}

function buildLocalDateTime(dateValue, timeValue) {
  const date = String(dateValue || "").slice(0, 10);
  const time = normalizeHourValue(timeValue, "");
  return date && time ? `${date}T${time}:00` : "";
}

function normalizeHourValue(raw, fallback) {
  const match = String(raw || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1]}:${match[2]}` : fallback;
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
