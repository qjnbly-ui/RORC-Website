const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_TYPES   = ["rental", "maintenance", "rorc"];
const VALID_STATUSES = ["confirmed", "cancelled"];
const RENTAL_BLOCKING_TYPES = ["rental", "maintenance"];

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
        // Return dates that should block new rentals — no auth required.
        path = `events?select=start_at,end_at,event_type&event_type=in.(${RENTAL_BLOCKING_TYPES.join(",")})&status=eq.confirmed&order=start_at.asc`;
        const rows = await supabaseRest(path);
        const dates = [...collectBlockedDates(rows)];
        return res.status(200).json({ success: true, dates });
      }

      if (isAdmin) {
        path = "events?select=*&order=start_at.asc&limit=500";
      } else {
        path = "events?select=*&is_public=eq.true&status=eq.confirmed&order=start_at.asc&limit=200";
      }

      const rows = await supabaseRest(path);
      return res.status(200).json({ success: true, events: rows.map(mapEvent) });
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
      return res.status(500).json({ success: false, error: "Could not create event" });
    }
  }

  // --- PATCH: update event ---
  if (req.method === "PATCH") {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: "Missing event ID" });

    const patch = {};
    if (fields.title       !== undefined) patch.title       = String(fields.title || "").trim().slice(0, 200);
    if (fields.description !== undefined) patch.description = String(fields.description || "").trim() || null;
    if (fields.event_type  !== undefined && VALID_TYPES.includes(fields.event_type))   patch.event_type = fields.event_type;
    if (fields.start_at    !== undefined) patch.start_at    = fields.start_at;
    if (fields.end_at      !== undefined) patch.end_at      = fields.end_at;
    if (fields.all_day     !== undefined) patch.all_day     = Boolean(fields.all_day);
    if (fields.is_public   !== undefined) patch.is_public   = Boolean(fields.is_public);
    if (fields.status      !== undefined && VALID_STATUSES.includes(fields.status)) patch.status = fields.status;
    if (fields.rental_request_id !== undefined) patch.rental_request_id = fields.rental_request_id || null;
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
  if (!VALID_TYPES.includes(body.event_type)) errors.push("Invalid event type.");
  if (!body.start_at || isNaN(Date.parse(body.start_at))) errors.push("Valid start date/time is required.");
  if (!body.end_at   || isNaN(Date.parse(body.end_at)))   errors.push("Valid end date/time is required.");
  if (new Date(body.start_at) >= new Date(body.end_at))   errors.push("End must be after start.");
  return errors;
}

function buildInsert(body) {
  return {
    title:       String(body.title || "").trim().slice(0, 200),
    description: String(body.description || "").trim() || null,
    event_type:  body.event_type,
    start_at:    body.start_at,
    end_at:      body.end_at,
    all_day:     Boolean(body.all_day),
    is_public:   Boolean(body.is_public),
    status:      VALID_STATUSES.includes(body.status) ? body.status : "confirmed",
    rental_request_id: body.rental_request_id || null,
    created_by:  String(body.created_by || "admin").trim()
  };
}

function mapEvent(row) {
  if (!row) return null;
  const normalizedType = normalizeEventType(row.event_type);
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
    createdBy:        row.created_by,
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
    const start = new Date(row.start_at);
    const end = new Date(row.end_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;

    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));

    while (cursor <= endDay) {
      blocked.add(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  });
  return blocked;
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
