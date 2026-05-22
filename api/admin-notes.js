const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token" });
    }

    const user = await getSupabaseUser(token);
    const manager = await getAccountMemberByAuthUserId(user.id);
    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({ success: false, error: "Only account managers can use admin notes." });
    }

    if (req.method === "GET") {
      const includeArchived = String(req.query?.includeArchived || "") === "1";
      const filters = includeArchived ? "" : "&archived_at=is.null";
      const rows = await supabaseRest(
        `admin_notes?select=id,note_text,is_done,created_at,completed_at,archived_at,created_by_member_id,completed_by_member_id,archived_by_member_id&order=created_at.desc${filters}`
      );
      return res.status(200).json({ success: true, notes: rows.map(mapAdminNoteRow) });
    }

    if (req.method === "POST") {
      const noteText = String(req.body?.noteText || "").trim();
      if (!noteText) {
        return res.status(400).json({ success: false, error: "noteText is required." });
      }

      const rows = await supabaseInsert("admin_notes", [{
        note_text: noteText,
        created_by_member_id: manager.id
      }]);
      return res.status(200).json({ success: true, note: mapAdminNoteRow(rows[0] || {}) });
    }

    if (req.method === "PATCH") {
      const id = String(req.body?.id || "").trim();
      if (!id) {
        return res.status(400).json({ success: false, error: "id is required." });
      }

      const existingRows = await supabaseRest(
        `admin_notes?select=id,note_text,is_done,archived_at&id=eq.${encodeURIComponent(id)}&limit=1`
      );
      const existing = existingRows[0];
      if (!existing) {
        return res.status(404).json({ success: false, error: "Admin note not found." });
      }

      const patch = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "isDone")) {
        const nextDone = Boolean(req.body.isDone);
        patch.is_done = nextDone;
        patch.completed_at = nextDone ? new Date().toISOString() : null;
        patch.completed_by_member_id = nextDone ? manager.id : null;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "archived")) {
        const nextArchived = Boolean(req.body.archived);
        patch.archived_at = nextArchived ? new Date().toISOString() : null;
        patch.archived_by_member_id = nextArchived ? manager.id : null;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "noteText")) {
        const nextNoteText = String(req.body.noteText || "").trim();
        if (!nextNoteText) {
          return res.status(400).json({ success: false, error: "noteText cannot be empty." });
        }
        patch.note_text = nextNoteText;
      }

      if (!Object.keys(patch).length) {
        return res.status(400).json({ success: false, error: "No valid fields to update." });
      }

      const rows = await supabasePatch(`admin_notes?id=eq.${encodeURIComponent(id)}`, patch);
      return res.status(200).json({ success: true, note: mapAdminNoteRow(rows[0] || {}) });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
};

function mapAdminNoteRow(row) {
  return {
    id: row.id || "",
    noteText: row.note_text || "",
    isDone: Boolean(row.is_done),
    createdAt: row.created_at || "",
    completedAt: row.completed_at || "",
    archivedAt: row.archived_at || "",
    createdByMemberId: row.created_by_member_id || "",
    completedByMemberId: row.completed_by_member_id || "",
    archivedByMemberId: row.archived_by_member_id || ""
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

  if (!response.ok) {
    throw httpError(401, "Invalid session");
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
    throw httpError(response.status, `REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function supabaseInsert(table, rows) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders({ prefer: "return=representation" }),
    body: JSON.stringify(rows)
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `Insert failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function supabasePatch(path, patch) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: supabaseHeaders({ prefer: "return=representation" }),
    body: JSON.stringify(patch)
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `Update failed: ${response.status} ${text}`);
  }

  return response.json();
}

function supabaseHeaders({ prefer = "" } = {}) {
  const headers = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
