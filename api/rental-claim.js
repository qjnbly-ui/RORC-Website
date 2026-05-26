const crypto = require("crypto");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RENTAL_ACCOUNT_TYPE = "Rental Account";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!SERVICE_ROLE_KEY) return res.status(500).json({ success: false, error: "Server configuration error" });

  try {
    if (req.method === "GET") {
      const token = String(req.query.token || "").trim();
      const rental = await loadClaimRental(token);
      return res.status(200).json({ success: true, booking: mapBooking(rental) });
    }

    if (req.method === "POST") {
      const token = String(req.body?.token || "").trim();
      const password = String(req.body?.password || "");
      if (password.length < 8) {
        return res.status(400).json({ success: false, error: "Password must be at least 8 characters." });
      }

      const rental = await loadClaimRental(token);
      if (rental.claimed_member_id) {
        return res.status(200).json({
          success: true,
          alreadyClaimed: true,
          booking: mapBooking(rental),
          dashboardUrl: `/member-dashboard/?booking=${encodeURIComponent(rental.booking_number || rental.id)}`,
          loginUrl: `/membership-login/?email=${encodeURIComponent(rental.contact_email || "")}`
        });
      }

      const email = normalizeEmail(rental.contact_email);
      const existingMember = email ? await findMemberByEmail(email) : null;
      const claim = existingMember
        ? await claimWithExistingMember({ rental, member: existingMember, password })
        : await claimWithNewRentalAccount({ rental, password });

      return res.status(200).json({
        success: true,
        reusedExistingAccount: Boolean(existingMember),
        booking: mapBooking(claim.rental || rental),
        email: claim.email || email,
        dashboardUrl: `/member-dashboard/?booking=${encodeURIComponent(rental.booking_number || rental.id)}`,
        loginUrl: `/membership-login/?email=${encodeURIComponent(claim.email || email)}`
      });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message || "Could not claim booking" });
  }
};

async function loadClaimRental(token) {
  if (!token) throw httpError(400, "Claim token is required");
  const tokenHash = hashToken(token);
  const rows = await supabaseRest(
    `rental_requests?select=*&claim_token_hash=eq.${encodeURIComponent(tokenHash)}&limit=1`
  );
  const rental = rows[0] || null;
  if (!rental) throw httpError(404, "Claim link is invalid or has already been replaced");
  if (rental.rental_status !== "confirmed") throw httpError(409, "This booking is not confirmed yet");
  if (rental.claim_token_expires_at && new Date(rental.claim_token_expires_at).getTime() < Date.now()) {
    throw httpError(410, "Claim link has expired. Contact RORC for a new link.");
  }
  return rental;
}

async function claimWithExistingMember({ rental, member, password }) {
  let authUserId = member.auth_user_id || "";
  if (!authUserId && member.email_address) {
    const authUser = await createAuthUser({
      email: member.email_address,
      password,
      name: member.member_name || rental.contact_name,
      accountId: member.account_id,
      accountMemberId: member.id
    }).catch((error) => {
      if (error.statusCode === 409) return null;
      throw error;
    });
    authUserId = authUser?.id || "";
    if (authUserId) {
      await supabaseWrite(
        `account_members?id=eq.${encodeURIComponent(member.id)}`,
        "PATCH",
        { auth_user_id: authUserId }
      );
    }
  }

  const rentalRows = await linkRentalToMember({ rentalId: rental.id, accountId: member.account_id, memberId: member.id });
  return {
    rental: rentalRows[0] || rental,
    email: member.email_address || rental.contact_email
  };
}

async function claimWithNewRentalAccount({ rental, password }) {
  const email = normalizeEmail(rental.contact_email);
  if (!email) throw httpError(400, "Booking email is required before this booking can be claimed.");

  const account = await insertSupabaseRow("accounts", {
    account_number: `RA-${String(rental.booking_number || rental.id).replace(/^RA-/i, "")}`,
    membership_details: RENTAL_ACCOUNT_TYPE,
    notes_on_account: [
      `Rental booking account for ${rental.booking_number || rental.id}.`,
      rental.contact_address ? `Mailing address: ${rental.contact_address}` : ""
    ].filter(Boolean).join("\n")
  });

  const member = await insertSupabaseRow("account_members", {
    account_id: account.id,
    member_name: rental.contact_name || "Rental Contact",
    account_type: RENTAL_ACCOUNT_TYPE,
    phone_number: rental.contact_phone || null,
    email_address: email,
    allow_guest_entry: false,
    allow_heater_use: false,
    can_access_independently: false,
    is_billing_owner: true
  });

  const authUser = await createAuthUser({
    email,
    password,
    name: member.member_name,
    accountId: account.id,
    accountMemberId: member.id
  });

  if (authUser?.id) {
    await supabaseWrite(
      `account_members?id=eq.${encodeURIComponent(member.id)}`,
      "PATCH",
      { auth_user_id: authUser.id }
    );
  }

  const rentalRows = await linkRentalToMember({ rentalId: rental.id, accountId: account.id, memberId: member.id });
  return {
    rental: rentalRows[0] || rental,
    email
  };
}

async function linkRentalToMember({ rentalId, accountId, memberId }) {
  const now = new Date().toISOString();
  const rentalRows = await supabaseWrite(
    `rental_requests?id=eq.${encodeURIComponent(rentalId)}`,
    "PATCH",
    {
      claimed_account_id: accountId,
      claimed_member_id: memberId,
      claimed_at: now
    }
  );

  await supabaseWrite(
    `events?rental_request_id=eq.${encodeURIComponent(rentalId)}`,
    "PATCH",
    {
      created_by: `member:${memberId}:rental:${rentalId}`,
      updated_at: now
    }
  ).catch((error) => {
    console.warn("Could not link calendar event owner for rental claim:", error?.message || error);
  });

  return rentalRows;
}

async function findMemberByEmail(email) {
  if (!email) return null;
  const rows = await supabaseRest(
    `account_members?select=id,account_id,member_name,account_type,email_address,phone_number,auth_user_id&email_address=eq.${encodeURIComponent(email)}&limit=1`
  );
  return rows[0] || null;
}

async function createAuthUser({ email, password, name, accountId, accountMemberId }) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: name,
        full_name: name,
        member_name: name,
        rorc_account_id: accountId,
        rorc_account_member_id: accountMemberId
      }
    })
  });

  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok) {
    const message = String(body?.msg || body?.message || text || "");
    if (response.status === 422 && /already|registered|exists/i.test(message)) {
      throw httpError(409, "This email already has a login. Use the member login page.");
    }
    throw new Error(`Could not create login user: ${response.status} ${message}`);
  }
  return body?.user || body;
}

function mapBooking(row) {
  return {
    id: row.id,
    bookingNumber: row.booking_number || "",
    status: row.rental_status || "",
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
    estimatedTotalCents: row.estimated_total_cents || 0,
    rentalType: row.rental_type || "",
    rentalHours: row.rental_hours || null,
    claimed: Boolean(row.claimed_member_id),
    claimedAt: row.claimed_at || ""
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

async function insertSupabaseRow(table, payload) {
  const rows = await supabaseWrite(table, "POST", payload);
  return rows[0];
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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
