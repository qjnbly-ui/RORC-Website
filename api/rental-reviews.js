const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_STATUSES = ["submitted", "pending_review", "confirmed", "rejected", "canceled"];

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Server configuration error" });
  }

  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: "Missing session token" });
  }

  try {
    const user = await getSupabaseUser(token);
    const member = await getAccountMember(user.id);
    if (!member || member.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Admin access required" });
    }
  } catch {
    return res.status(401).json({ success: false, error: "Invalid session" });
  }

  if (req.method === "GET") {
    try {
      const rows = await supabaseRest(
        "rental_requests?select=*&order=created_at.desc&limit=200"
      );
      return res.status(200).json({ success: true, requests: rows.map(mapRow) });
    } catch (err) {
      console.error("rental-reviews GET error:", err);
      return res.status(500).json({ success: false, error: "Could not load rental requests" });
    }
  }

  if (req.method === "PATCH") {
    const { id, status, adminNotes } = req.body || {};

    if (!id || typeof id !== "string") {
      return res.status(400).json({ success: false, error: "Missing rental request ID" });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
    }

    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/rental_requests?id=eq.${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            rental_status: status,
            admin_notes: typeof adminNotes === "string" ? adminNotes.trim() : null,
            reviewed_at: new Date().toISOString()
          })
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase PATCH failed: ${response.status} ${text}`);
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("rental-reviews PATCH error:", err);
      return res.status(500).json({ success: false, error: "Could not update rental request" });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
};

function mapRow(row) {
  return {
    id: row.id,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    contactAddress: row.contact_address,
    eventType: row.event_type,
    eventDate: row.event_date,
    eventStartTime: row.event_start_time,
    eventEndTime: row.event_end_time,
    estimatedAttendance: row.estimated_attendance,
    foodOrDrinks: row.food_or_drinks,
    alcohol: row.alcohol,
    addonTables: row.addon_tables,
    addonChairs: row.addon_chairs,
    addonTarp: row.addon_tarp,
    addonHeater: row.addon_heater,
    addonEarlySetup: row.addon_early_setup,
    addonEarlyDayRental: row.addon_early_day_rental,
    addonLateCleanup: row.addon_late_cleanup,
    addonLateDayRental: row.addon_late_day_rental,
    estimatedTotalCents: row.estimated_total_cents,
    rentalStatus: row.rental_status,
    adminNotes: row.admin_notes,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at
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
