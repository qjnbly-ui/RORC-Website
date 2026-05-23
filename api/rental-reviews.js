const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";

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
          body: JSON.stringify({
            rental_status: status,
            admin_notes: typeof adminNotes === "string" ? adminNotes.trim() : null,
            reviewed_at: new Date().toISOString()
          })
        }
      );

      if (!patchRes.ok) {
        const text = await patchRes.text();
        throw new Error(`Supabase PATCH failed: ${patchRes.status} ${text}`);
      }

      const rows = await patchRes.json();
      const record = rows[0];

      if (record && (status === "confirmed" || status === "rejected")) {
        sendApplicantEmail(record, status, adminNotes).catch((err) => {
          console.error("Rental applicant email failed:", err);
        });
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

async function sendApplicantEmail(record, status, adminNotes) {
  if (!RESEND_API_KEY || !record?.contact_email) return;

  const firstName = (record.contact_name || "").split(" ")[0] || "there";
  const isConfirmed = status === "confirmed";

  const notes = typeof adminNotes === "string" && adminNotes.trim()
    ? `<p style="margin:16px 0 0;padding:14px 16px;background:#222;border-radius:8px;color:#ccc;font-size:14px;text-align:left;">${esc(adminNotes.trim())}</p>`
    : "";

  const bodyHtml = isConfirmed
    ? `
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Hi ${esc(firstName)},</p>
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Great news — your rental request for a <strong style="color:#fff;">${esc(record.event_type)}</strong> on <strong style="color:#fff;">${esc(record.event_date)}</strong> has been <strong style="color:#fff;">confirmed</strong>.</p>
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">RORC staff will be in touch with next steps and payment details. If you have any questions, please reach out to us directly.</p>
${notes}
<p style="margin:24px 0 0;color:#888;font-size:13px;">We look forward to hosting your event!</p>
`
    : `
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Hi ${esc(firstName)},</p>
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Thank you for submitting a rental request for a <strong style="color:#fff;">${esc(record.event_type)}</strong> on <strong style="color:#fff;">${esc(record.event_date)}</strong>.</p>
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Unfortunately, we are unable to accommodate your request at this time.</p>
${notes}
<p style="margin:24px 0 0;color:#888;font-size:13px;">If you have questions, please contact RORC directly.</p>
`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [record.contact_email],
      subject: isConfirmed
        ? `Your Rental Request Has Been Confirmed — ${esc(record.event_date)}`
        : `Update on Your RORC Rental Request`,
      html: buildEmailTemplate({
        title: isConfirmed ? "Rental Confirmed" : "Rental Request Update",
        bodyHtml
      })
    })
  });
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
