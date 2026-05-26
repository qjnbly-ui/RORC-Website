const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_REQUEST_TYPES = new Set(["create", "update", "delete"]);
const VALID_REVIEW_ACTIONS = new Set(["approve", "reject"]);
const ACTIVE_REQUEST_STATUS = "pending";
const INACTIVE_ACCOUNT_TYPES = new Set(["restricted account", "kiosk account"]);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!SERVICE_ROLE_KEY) return res.status(500).json({ success: false, error: "Server configuration error" });

  let member;
  try {
    member = await authMember(req);
  } catch (error) {
    return res.status(error.statusCode || 401).json({ success: false, error: error.message || "Invalid session" });
  }

  if (req.method === "GET") {
    try {
      const admin = isAccountManager(member);
      const includeEvents = req.query.includeEvents === "true";
      const mineOnly = req.query.scope === "mine";
      const requestPath = admin && !mineOnly
        ? "calendar_event_requests?select=*&order=created_at.desc&limit=300"
        : `calendar_event_requests?select=*&requester_member_id=eq.${encodeURIComponent(member.id)}&order=created_at.desc&limit=200`;

      const [requestRows, eventRows] = await Promise.all([
        supabaseRest(requestPath),
        includeEvents ? loadMemberOwnedEvents(member.id) : Promise.resolve([])
      ]);

      return res.status(200).json({
        success: true,
        requests: (requestRows || []).map(mapRequest),
        events: (eventRows || []).map(mapEvent)
      });
    } catch (error) {
      console.error("calendar-event-requests GET error:", error);
      return res.status(500).json({ success: false, error: "Could not load calendar event requests" });
    }
  }

  if (req.method === "POST") {
    if (!isEligibleEventRequester(member)) {
      return res.status(403).json({ success: false, error: "Active member account required" });
    }

    const body = req.body || {};
    const requestType = String(body.requestType || body.request_type || "").trim();
    const targetEventId = String(body.targetEventId || body.target_event_id || "").trim();

    if (!VALID_REQUEST_TYPES.has(requestType)) {
      return res.status(400).json({ success: false, error: "Invalid request type" });
    }
    if ((requestType === "update" || requestType === "delete") && !targetEventId) {
      return res.status(400).json({ success: false, error: "Target event is required" });
    }

    try {
      let target = null;
      if (targetEventId) {
        target = await loadEventById(targetEventId);
        if (!target || !isOwnedMemberEvent(target, member.id)) {
          return res.status(403).json({ success: false, error: "You can only change your own approved events" });
        }
        if (target.rental_request_id) {
          return res.status(403).json({ success: false, error: "Linked rental events must be managed by staff" });
        }
        await cancelPendingTargetRequests(member.id, targetEventId);
      }

      const eventPayload = requestType === "delete"
        ? eventSnapshotFromRow(target)
        : buildMemberEventPayload(body.event || body.eventPayload || {});

      const insertPayload = {
        requester_member_id: member.id,
        target_event_id: targetEventId || null,
        request_type: requestType,
        status: ACTIVE_REQUEST_STATUS,
        event_payload: eventPayload,
        requester_snapshot: requesterSnapshot(member)
      };

      const rows = await supabaseWrite("calendar_event_requests", "POST", insertPayload);
      return res.status(200).json({ success: true, request: mapRequest(rows[0]) });
    } catch (error) {
      console.error("calendar-event-requests POST error:", error);
      return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Could not submit request" });
    }
  }

  if (req.method === "PATCH") {
    if (!isAccountManager(member)) {
      return res.status(403).json({ success: false, error: "Admin access required" });
    }

    const body = req.body || {};
    const id = String(body.id || "").trim();
    const action = String(body.action || "").trim();
    const reviewNotes = String(body.reviewNotes || body.review_notes || "").trim() || null;

    if (!id) return res.status(400).json({ success: false, error: "Request ID is required" });
    if (!VALID_REVIEW_ACTIONS.has(action)) {
      return res.status(400).json({ success: false, error: "Invalid review action" });
    }

    try {
      const request = await loadRequestById(id);
      if (!request) return res.status(404).json({ success: false, error: "Request not found" });
      if (request.status !== ACTIVE_REQUEST_STATUS) {
        return res.status(409).json({ success: false, error: "This request has already been reviewed" });
      }

      const approvalPatch = action === "approve" ? await approveRequest(request) : {};

      const rows = await supabaseWrite(
        `calendar_event_requests?id=eq.${encodeURIComponent(id)}`,
        "PATCH",
        {
          ...approvalPatch,
          status: action === "approve" ? "approved" : "rejected",
          review_notes: reviewNotes,
          reviewed_by_member_id: member.id,
          reviewed_at: new Date().toISOString()
        }
      );

      return res.status(200).json({ success: true, request: mapRequest(rows[0]) });
    } catch (error) {
      console.error("calendar-event-requests PATCH error:", error);
      return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Could not review request" });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
};

async function authMember(req) {
  const token = bearerToken(req);
  if (!token) throw httpError(401, "Missing session token");

  const user = await getSupabaseUser(token);
  const member = await getAccountMember(user.id);
  if (!member) throw httpError(403, "This session is not linked to a member");
  return member;
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function getSupabaseUser(token) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw httpError(401, "Invalid session");
  return response.json();
}

async function getAccountMember(authUserId) {
  const rows = await supabaseRest(
    `account_members?select=id,account_id,member_name,account_type,email_address,phone_number&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
  );
  return rows[0] || null;
}

function isAccountManager(member) {
  return String(member?.account_type || "") === "Account Manager";
}

function isEligibleEventRequester(member) {
  const accountType = String(member?.account_type || "").trim().toLowerCase();
  return Boolean(member?.id) && !INACTIVE_ACCOUNT_TYPES.has(accountType);
}

async function loadMemberOwnedEvents(memberId) {
  const markers = [`member:${memberId}*`, `special_access:${memberId}*`];
  const results = await Promise.all(markers.map((marker) => supabaseRest(
    `events?select=*&created_by=like.${encodeURIComponent(marker)}&status=eq.confirmed&order=start_at.asc&limit=500`
  )));
  const seen = new Map();
  results.flat().forEach((row) => {
    if (row?.id) seen.set(row.id, row);
  });
  return [...seen.values()].sort((a, b) => String(a.start_at || "").localeCompare(String(b.start_at || "")));
}

async function loadEventById(id) {
  const rows = await supabaseRest(`events?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows[0] || null;
}

async function loadRequestById(id) {
  const rows = await supabaseRest(`calendar_event_requests?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows[0] || null;
}

async function cancelPendingTargetRequests(memberId, targetEventId) {
  await supabaseWrite(
    `calendar_event_requests?requester_member_id=eq.${encodeURIComponent(memberId)}&target_event_id=eq.${encodeURIComponent(targetEventId)}&status=eq.${ACTIVE_REQUEST_STATUS}`,
    "PATCH",
    { status: "canceled" }
  ).catch(() => []);
}

async function approveRequest(request) {
  const requestType = request.request_type;
  const requesterId = request.requester_member_id;
  const targetEventId = request.target_event_id;
  const payload = normalizeStoredPayload(request.event_payload || {});

  if (requestType === "create") {
    const rows = await supabaseWrite("events", "POST", buildEventInsert(payload, request));
    return rows[0]?.id ? { target_event_id: rows[0].id } : {};
  }

  if (!targetEventId) throw httpError(400, "Target event is required");
  const target = await loadEventById(targetEventId);
  if (!target || !isOwnedMemberEvent(target, requesterId)) {
    throw httpError(409, "The target event no longer belongs to this requester");
  }
  if (target.rental_request_id) {
    throw httpError(409, "Linked rental events must be managed by staff");
  }

  if (requestType === "update") {
    await supabaseWrite(
      `events?id=eq.${encodeURIComponent(targetEventId)}`,
      "PATCH",
      buildEventPatch(payload, target.created_by || memberOwnedCreatedBy(requesterId, request.id))
    );
    return {};
  }

  if (requestType === "delete") {
    await supabaseDelete(`events?id=eq.${encodeURIComponent(targetEventId)}`);
    return {};
  }

  throw httpError(400, "Invalid request type");
}

function buildMemberEventPayload(raw) {
  const title = String(raw.title || "").trim().slice(0, 200);
  const startAt = String(raw.start_at || raw.startAt || "").trim();
  const endAt = String(raw.end_at || raw.endAt || "").trim();
  const allDay = Boolean(raw.all_day ?? raw.allDay);

  if (!title) throw httpError(400, "Title is required");
  if (!startAt || Number.isNaN(Date.parse(startAt))) throw httpError(400, "Valid start date/time is required");
  if (!endAt || Number.isNaN(Date.parse(endAt))) throw httpError(400, "Valid end date/time is required");
  if (new Date(startAt) >= new Date(endAt)) throw httpError(400, "End must be after start");

  return {
    title,
    description: String(raw.description || "").trim() || null,
    event_type: "public_event",
    start_at: startAt,
    end_at: endAt,
    all_day: allDay,
    is_public: true,
    status: "confirmed",
    detail_only: Boolean(raw.detail_only ?? raw.detailOnly)
  };
}

function normalizeStoredPayload(raw) {
  return buildMemberEventPayload(raw || {});
}

function buildEventInsert(payload, request) {
  return {
    title: payload.title,
    description: payload.description,
    event_type: "public_event",
    start_at: payload.start_at,
    end_at: payload.end_at,
    all_day: Boolean(payload.all_day),
    is_public: true,
    status: "confirmed",
    rental_request_id: null,
    created_by: memberOwnedCreatedBy(request.requester_member_id, request.id, payload.detail_only)
  };
}

function buildEventPatch(payload, existingCreatedBy) {
  const cleanCreatedBy = cleanCreatedByCore(existingCreatedBy);
  return {
    title: payload.title,
    description: payload.description,
    event_type: "public_event",
    start_at: payload.start_at,
    end_at: payload.end_at,
    all_day: Boolean(payload.all_day),
    is_public: true,
    status: "confirmed",
    rental_request_id: null,
    created_by: payload.detail_only ? `${cleanCreatedBy}:detail` : cleanCreatedBy,
    updated_at: new Date().toISOString()
  };
}

function cleanCreatedByCore(createdBy) {
  return String(createdBy || "admin")
    .replace(/(^|[:;|])detail(?:$|[:;|])/g, "")
    .replace(/[:;|]{2,}/g, ":")
    .replace(/^[:;|]|[:;|]$/g, "")
    || "admin";
}

function memberOwnedCreatedBy(memberId, requestId, detailOnly = false) {
  return `member:${memberId}:request:${requestId}${detailOnly ? ":detail" : ""}`;
}

function isOwnedMemberEvent(row, memberId) {
  const escapedMemberId = escapeRegExp(String(memberId || ""));
  const ownerPattern = new RegExp(`^(?:member|special_access):${escapedMemberId}(?::|$)`);
  return ownerPattern.test(String(row?.created_by || ""));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function eventSnapshotFromRow(row) {
  if (!row) return {};
  return {
    title: row.title || "",
    description: row.description || null,
    event_type: row.event_type || "public_event",
    start_at: row.start_at,
    end_at: row.end_at,
    all_day: Boolean(row.all_day),
    is_public: Boolean(row.is_public),
    status: row.status || "confirmed",
    detail_only: /(^|[:;|])detail(?:$|[:;|])/.test(String(row.created_by || ""))
  };
}

function requesterSnapshot(member) {
  return {
    memberId: member.id,
    accountId: member.account_id || "",
    memberName: member.member_name || "",
    accountType: member.account_type || "",
    phoneNumber: member.phone_number || "",
    emailAddress: member.email_address || ""
  };
}

function mapRequest(row) {
  const snapshot = row.requester_snapshot || {};
  return {
    id: row.id,
    requesterMemberId: row.requester_member_id,
    targetEventId: row.target_event_id,
    requestType: row.request_type,
    status: row.status,
    eventPayload: row.event_payload || {},
    requester: {
      memberId: snapshot.memberId || row.requester_member_id,
      accountId: snapshot.accountId || "",
      memberName: snapshot.memberName || "",
      accountType: snapshot.accountType || "",
      phoneNumber: snapshot.phoneNumber || "",
      emailAddress: snapshot.emailAddress || ""
    },
    reviewNotes: row.review_notes || "",
    reviewedByMemberId: row.reviewed_by_member_id || "",
    reviewedAt: row.reviewed_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapEvent(row) {
  if (!row) return null;
  const createdBy = String(row.created_by || "");
  const seriesMatch = createdBy.match(/(?:^|:)series:([a-zA-Z0-9_-]+)/);
  const detailOnly = /(^|[:;|])detail(?:$|[:;|])/.test(createdBy);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    eventType: normalizeEventType(row.event_type),
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: Boolean(row.all_day),
    isPublic: Boolean(row.is_public),
    status: row.status,
    rentalRequestId: row.rental_request_id,
    rentalAccessStartAt: "",
    rentalAccessEndAt: "",
    createdBy: row.created_by,
    detailOnly,
    isRecurring: Boolean(seriesMatch),
    recurringSeriesId: seriesMatch ? seriesMatch[1] : "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeEventType(value) {
  const raw = String(value || "").trim();
  if (raw === "rental" || raw === "maintenance" || raw === "rorc") return raw;
  return "rorc";
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
    throw new Error(`Supabase ${method} failed: ${response.status} ${text}`);
  }
  return response.json();
}

async function supabaseDelete(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase DELETE failed: ${response.status} ${text}`);
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
