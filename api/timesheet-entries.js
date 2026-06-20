const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FACILITY_TIME_ZONE = "America/Los_Angeles";

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token" });
    }

    const user = await getSupabaseUser(token);
    const actor = await getAccountMemberByAuthUserId(user.id);
    const role = String(actor?.account_type || "");

    if (role !== "Kiosk Account") {
      return res.status(403).json({ success: false, error: "Only kiosk accounts can use global timesheet access." });
    }

    if (req.method === "GET") {
      const [recentRows, openRows] = await Promise.all([
        supabaseRest("timesheet_entries?select=*&order=signed_in_at.desc&limit=250"),
        supabaseRest("timesheet_entries?select=*&signed_out_at=is.null&order=signed_in_at.desc&limit=100")
      ]);
      return res.status(200).json({ success: true, entries: mergeTimesheetRows(recentRows, openRows) });
    }

    if (req.method === "POST") {
      const entries = normalizeEntries(req.body?.entries || req.body?.entry);
      if (!entries.length) {
        return res.status(400).json({ success: false, error: "No timesheet entries provided." });
      }

      await validateEntries(entries);

      const response = await fetch(`${SUPABASE_URL}/rest/v1/timesheet_entries`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(entries)
      });

      if (!response.ok) {
        const text = await response.text();
        throw httpError(response.status, `Could not create timesheet entry: ${response.status} ${text}`);
      }

      return res.status(200).json({ success: true, entries: await response.json() });
    }

    if (req.method === "PATCH") {
      const entryId = String(req.body?.entryId || "").trim();
      const signOutGuestsForMemberId = String(req.body?.signOutGuestsForMemberId || "").trim();
      const signedOutAt = String(req.body?.signedOutAt || new Date().toISOString()).trim();

      if (!entryId) {
        return res.status(400).json({ success: false, error: "Missing timesheet entry ID." });
      }

      await patchTimesheet(
        `id=eq.${encodeURIComponent(entryId)}&signed_out_at=is.null`,
        { signed_out_at: signedOutAt }
      );

      if (signOutGuestsForMemberId) {
        await patchTimesheet(
          [
            "member_or_guest=eq.Guest",
            `member_entered_with_id=eq.${encodeURIComponent(signOutGuestsForMemberId)}`,
            "signed_out_at=is.null"
          ].join("&"),
          { signed_out_at: signedOutAt }
        );
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message || "Server error" });
  }
};

function normalizeEntries(input) {
  const rows = Array.isArray(input) ? input : [input];

  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const kind = String(row.member_or_guest || "").trim();
      const signedInAt = String(row.signed_in_at || new Date().toISOString()).trim();

      if (kind === "Member") {
        const memberId = String(row.member_id || "").trim();
        if (!memberId) return null;
        return {
          member_or_guest: "Member",
          member_id: memberId,
          signed_in_at: signedInAt
        };
      }

      if (kind === "Guest") {
        const guestName = String(row.guest_name || "").trim();
        const passType = String(row.day_pass_or_open_gym || "").trim();
        const sponsorId = String(row.member_entered_with_id || "").trim();
        if (!guestName || !sponsorId || !["Day Pass", "Open Gym"].includes(passType)) return null;
        return {
          member_or_guest: "Guest",
          guest_name: guestName,
          day_pass_or_open_gym: passType,
          member_entered_with_id: sponsorId,
          liability_accepted: true,
          signed_in_at: signedInAt
        };
      }

      return null;
    })
    .filter(Boolean);
}

function mergeTimesheetRows(...rowGroups) {
  const byId = new Map();
  rowGroups.flat().filter(Boolean).forEach((row) => {
    if (row.id) byId.set(row.id, row);
  });
  return [...byId.values()]
    .sort((a, b) => new Date(b.signed_in_at || 0) - new Date(a.signed_in_at || 0));
}

async function validateEntries(entries) {
  const memberIds = [...new Set(entries.flatMap((entry) => (
    entry.member_or_guest === "Member"
      ? [entry.member_id]
      : [entry.member_entered_with_id]
  )).filter(Boolean))];

  if (!memberIds.length) {
    throw httpError(400, "No members found for timesheet entries.");
  }

  const idList = memberIds.map((id) => `"${String(id).replaceAll('"', "")}"`).join(",");
  const members = await supabaseRest(
    `account_members?select=id,member_name,account_type,allow_guest_entry&id=in.(${encodeURIComponent(idList)})`
  );
  const memberById = new Map((members || []).map((member) => [member.id, member]));
  const permissionRows = await supabaseRest(
    "account_type_permissions?select=account_type,can_sign_in,bypass_time_windows,allowed_days,allowed_start_time,allowed_end_time"
  );
  const policies = normalizePermissionRows(permissionRows || []);

  entries.forEach((entry) => {
    const memberId = entry.member_or_guest === "Member" ? entry.member_id : entry.member_entered_with_id;
    const member = memberById.get(memberId);
    const signedInAt = new Date(entry.signed_in_at || Date.now());

    if (!member) {
      throw httpError(400, "Selected member was not found.");
    }

    const validation = canMemberSignInNow(member, signedInAt, policies);
    if (!validation.allowed) {
      throw httpError(400, `${member.member_name || "Selected member"}: ${validation.reason}`);
    }

    if (entry.member_or_guest === "Guest" && entry.day_pass_or_open_gym !== "Open Gym" && !member.allow_guest_entry) {
      throw httpError(400, `${member.member_name || "Selected member"} cannot bring Day Pass guests outside Open Gym.`);
    }
  });
}

function normalizePermissionRows(rows) {
  const defaults = defaultAccountTypePolicies();
  const next = { ...defaults };

  rows.forEach((row) => {
    const type = canonicalAccountType(row.account_type);
    next[type] = {
      accountType: type,
      canSignIn: row.can_sign_in !== false,
      bypassTimeWindows: Boolean(row.bypass_time_windows),
      allowedDays: Array.isArray(row.allowed_days) ? row.allowed_days.map(Number).filter((value) => Number.isInteger(value)) : [],
      allowedStartTime: row.allowed_start_time || null,
      allowedEndTime: row.allowed_end_time || null
    };
  });

  return next;
}

function defaultAccountTypePolicies() {
  return {
    "Account Manager": { canSignIn: true, bypassTimeWindows: true, allowedDays: [], allowedStartTime: null, allowedEndTime: null },
    "Kiosk Account": { canSignIn: true, bypassTimeWindows: true, allowedDays: [], allowedStartTime: null, allowedEndTime: null },
    "Special Access Account": { canSignIn: true, bypassTimeWindows: true, allowedDays: [], allowedStartTime: null, allowedEndTime: null },
    "Active Membership": { canSignIn: true, bypassTimeWindows: false, allowedDays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: "06:50", allowedEndTime: "21:10" },
    "Work Exchange Membership Program": { canSignIn: true, bypassTimeWindows: false, allowedDays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: "06:50", allowedEndTime: "21:10" },
    "Weight Room Only": { canSignIn: true, bypassTimeWindows: false, allowedDays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: "06:50", allowedEndTime: "21:10" },
    "Open Gym Only": { canSignIn: true, bypassTimeWindows: false, allowedDays: [2, 4], allowedStartTime: "17:50", allowedEndTime: "20:10" },
    "RESTRICTED ACCOUNT": { canSignIn: false, bypassTimeWindows: false, allowedDays: [], allowedStartTime: null, allowedEndTime: null }
  };
}

function canMemberSignInNow(member, signedInAt, policies) {
  const type = canonicalAccountType(member?.account_type);
  const policy = policies[type] || defaultAccountTypePolicies()[type];

  if (!policy?.canSignIn) {
    return { allowed: false, reason: `${type} is temporarily restricted from sign-in.` };
  }

  if (policy.bypassTimeWindows) {
    return { allowed: true, reason: "" };
  }

  const weekday = facilityWeekdayIndex(signedInAt);
  const allowedDays = Array.isArray(policy.allowedDays) ? policy.allowedDays : [];
  if (allowedDays.length && !allowedDays.includes(weekday)) {
    return { allowed: false, reason: `${type} cannot sign in on this day.` };
  }

  const nowMinutes = minuteOfDayFacility(signedInAt);
  const startMinutes = parseTimeStringToMinutes(policy.allowedStartTime);
  const endMinutes = parseTimeStringToMinutes(policy.allowedEndTime);
  if (!isWithinTimeWindow(nowMinutes, startMinutes, endMinutes)) {
    return { allowed: false, reason: `${type} is outside its allowed sign-in time window.` };
  }

  return { allowed: true, reason: "" };
}

function parseTimeStringToMinutes(value) {
  if (!value) return null;
  const [hoursRaw, minutesRaw] = String(value).split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return (hours * 60) + minutes;
}

function isWithinTimeWindow(nowMinutes, startMinutes, endMinutes) {
  if (startMinutes === null || endMinutes === null) return true;
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

function facilityClockParts(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) {
    return { weekday: "", weekdayIndex: null, hour: 0, minute: 0 };
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

  const weekdayIndexes = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = parts.hour === "24" ? 0 : Number(parts.hour || 0);
  const minute = Number(parts.minute || 0);
  return {
    weekday: parts.weekday || "",
    weekdayIndex: Object.prototype.hasOwnProperty.call(weekdayIndexes, parts.weekday) ? weekdayIndexes[parts.weekday] : null,
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0
  };
}

function facilityWeekdayIndex(date) {
  const parts = facilityClockParts(date);
  return parts.weekdayIndex ?? date.getDay();
}

function minuteOfDayFacility(date) {
  const parts = facilityClockParts(date);
  return (parts.hour * 60) + parts.minute;
}

function canonicalAccountType(accountType) {
  const normalized = String(accountType || "").trim().toLowerCase();
  if (normalized === "account manager") return "Account Manager";
  if (normalized === "kiosk account") return "Kiosk Account";
  if (normalized === "special access account") return "Special Access Account";
  if (normalized === "active membership") return "Active Membership";
  if (normalized === "work exchange membership program") return "Work Exchange Membership Program";
  if (normalized === "weight room only") return "Weight Room Only";
  if (normalized === "open gym only") return "Open Gym Only";
  if (normalized === "restricted account") return "RESTRICTED ACCOUNT";
  return String(accountType || "").trim() || "Active Membership";
}

async function patchTimesheet(query, payload) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/timesheet_entries?${query}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `Could not update timesheet entry: ${response.status} ${text}`);
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
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw httpError(response.status, `REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
