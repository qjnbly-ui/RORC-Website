const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET_NAME = "sponsor-submissions";
const VALID_STATUSES = new Set(["submitted", "in_review", "invoiced", "paid", "complete", "canceled"]);

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured." });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token." });
    }

    const user = await getSupabaseUser(token);
    const manager = await getAccountMemberByAuthUserId(user.id);
    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Only account managers can review sponsor submissions." });
    }

    if (req.method === "GET") {
      if (String(req.query?.summary || "") === "1") {
        const rows = await supabaseRest(
          "sponsor_banner_submissions?select=status&status=eq.submitted&limit=500"
        );
        return res.status(200).json({ success: true, pendingCount: rows.length });
      }
      const submissions = await loadSponsorSubmissions();
      return res.status(200).json({ success: true, submissions });
    }

    if (req.method === "POST") {
      const id = str(req.body?.id);
      const action = str(req.body?.action).toLowerCase();
      if (!id) return res.status(400).json({ success: false, error: "Missing submission ID." });

      if (action === "status") {
        const status = str(req.body?.status).toLowerCase();
        if (!VALID_STATUSES.has(status)) {
          return res.status(400).json({ success: false, error: "Invalid sponsor submission status." });
        }
        const rows = await supabaseWrite(
          `sponsor_banner_submissions?id=eq.${encodeURIComponent(id)}`,
          "PATCH",
          { status }
        );
        return res.status(200).json({ success: true, submission: mapSponsorSubmission(rows[0] || {}) });
      }

      if (action === "delete") {
        const rows = await supabaseRest(
          `sponsor_banner_submissions?select=id,logo_files&id=eq.${encodeURIComponent(id)}&limit=1`
        );
        const row = rows[0];
        if (!row) return res.status(404).json({ success: false, error: "Sponsor submission was not found." });

        await deleteSponsorFiles(row.logo_files || []);
        await supabaseDelete(`sponsor_banner_submissions?id=eq.${encodeURIComponent(id)}`);
        return res.status(200).json({ success: true, id });
      }

      return res.status(400).json({ success: false, error: "Invalid sponsor submission action." });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message || "Could not load sponsor submissions." });
  }
};

async function loadSponsorSubmissions() {
  const rows = await supabaseRest(
    "sponsor_banner_submissions?select=*&order=created_at.desc&limit=200"
  );
  return Promise.all(rows.map(mapSponsorSubmissionWithLinks));
}

async function mapSponsorSubmissionWithLinks(row) {
  const mapped = mapSponsorSubmission(row);
  mapped.logoFiles = await Promise.all((mapped.logoFiles || []).map(async (file) => ({
    ...file,
    signedUrl: file.path ? await createSignedFileUrl(file.path).catch(() => "") : ""
  })));
  return mapped;
}

function mapSponsorSubmission(row) {
  return {
    id: row.id || "",
    createdAt: row.created_at || "",
    sponsorshipType: row.sponsorship_type || "",
    amountCents: Number(row.amount_cents || 0),
    businessName: row.business_name || "",
    contactName: row.contact_name || "",
    emailAddress: row.email_address || "",
    phoneNumber: row.phone_number || "",
    bannerText: row.banner_text || "",
    designRequests: row.design_requests || "",
    paymentMethod: row.payment_method || "",
    priceAcknowledged: Boolean(row.price_acknowledged),
    logoFiles: Array.isArray(row.logo_files) ? row.logo_files : [],
    status: row.status || "submitted"
  };
}

async function createSignedFileUrl(path) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET_NAME}/${encodeStoragePath(path)}`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ expiresIn: 60 * 60 })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not create file link: ${response.status} ${text}`);
  }
  const body = await response.json();
  const signedUrl = body.signedURL || body.signedUrl || "";
  return signedUrl ? `${SUPABASE_URL}/storage/v1${signedUrl}` : "";
}

async function deleteSponsorFiles(files) {
  const paths = (Array.isArray(files) ? files : [])
    .map((file) => str(file?.path))
    .filter(Boolean);
  if (!paths.length) return;

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_NAME}`, {
    method: "DELETE",
    headers: supabaseHeaders(),
    body: JSON.stringify({ prefixes: paths })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not delete sponsor files: ${response.status} ${text}`);
  }
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

  if (!response.ok) {
    throw httpError(401, "Invalid session.");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(`account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`);
  return rows[0] || null;
}

async function supabaseRest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: supabaseHeaders()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function supabaseWrite(path, method, payload) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      ...supabaseHeaders(),
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

async function supabaseDelete(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: supabaseHeaders()
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST delete failed: ${response.status} ${text}`);
  }
}

function supabaseHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}

function encodeStoragePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function str(value) {
  return String(value || "").trim();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
