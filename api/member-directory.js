const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DIRECTORY_CACHE_MS = 60 * 1000;
const DIRECTORY_PROFILE_COLUMNS = [
  "account_member_id",
  "account_id",
  "account_number",
  "member_name",
  "account_type",
  "legacy_account_type",
  "phone_number",
  "email_address",
  "image_path",
  "allow_guest_entry",
  "is_billing_owner",
  "allow_heater_use",
  "date_of_birth",
  "guardian_member_id",
  "can_access_independently"
].join(",");
let cachedDirectoryRows = null;
let cachedDirectoryAt = 0;

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured" });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing session token" });
    }

    const user = await getSupabaseUser(token);
    const currentMember = await getAccountMemberByAuthUserId(user.id);
    const role = String(currentMember?.account_type || "");

    if (!["Account Manager", "Kiosk Account"].includes(role)) {
      return res.status(403).json({ success: false, error: "Only account managers and kiosk accounts can load full directory." });
    }

    const now = Date.now();
    if (cachedDirectoryRows && now - cachedDirectoryAt < DIRECTORY_CACHE_MS) {
      return res.status(200).json({ success: true, members: cachedDirectoryRows, cached: true });
    }

    const directory = await loadDirectoryRows();
    cachedDirectoryRows = directory.rows;
    cachedDirectoryAt = now;

    return res.status(200).json({
      success: true,
      members: directory.rows,
      warning: directory.warning || ""
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Server error" });
  }
};

async function loadDirectoryRows() {
  try {
    const rows = await supabaseRest(
      `account_member_profiles?select=${DIRECTORY_PROFILE_COLUMNS}&order=account_number.asc.nullslast,member_name.asc.nullslast&limit=10000`
    );
    return { rows: sortDirectoryRows(await hydrateDirectoryMailingAddresses(rows || [])), warning: "" };
  } catch (viewError) {
    console.warn("Member directory profile view unavailable:", viewError?.message || viewError);
  }

  try {
    const rows = await loadDirectoryRowsFromBaseTables();
    return { rows: sortDirectoryRows(await hydrateDirectoryMailingAddresses(rows)), warning: "Loaded member directory from fallback tables." };
  } catch (fallbackError) {
    console.error("Member directory fallback unavailable:", fallbackError?.message || fallbackError);
    return { rows: [], warning: "Member directory is temporarily unavailable." };
  }
}

async function hydrateDirectoryMailingAddresses(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];

  try {
    const contracts = await supabaseRest(
      "signup_contracts?select=account_id,primary_member_id,contract_payload,created_at&order=created_at.desc&limit=10000"
    );
    const addressByAccountId = new Map();
    const addressByMemberId = new Map();

    (contracts || []).forEach((contract) => {
      const address = String(contract?.contract_payload?.primary?.address || "").trim();
      if (!address) return;
      if (contract.primary_member_id && !addressByMemberId.has(contract.primary_member_id)) {
        addressByMemberId.set(contract.primary_member_id, address);
      }
      if (contract.account_id && !addressByAccountId.has(contract.account_id)) {
        addressByAccountId.set(contract.account_id, address);
      }
    });

    return rows.map((row) => {
      const memberId = row.account_member_id || row.id || "";
      const accountId = row.account_id || "";
      return {
        ...row,
        mailing_address: addressByMemberId.get(memberId) || addressByAccountId.get(accountId) || ""
      };
    });
  } catch (error) {
    console.warn("Member directory mailing addresses unavailable:", error?.message || error);
    return rows.map((row) => ({ ...row, mailing_address: row.mailing_address || "" }));
  }
}

async function loadDirectoryRowsFromBaseTables() {
  const [members, accounts, billingRows] = await Promise.all([
    supabaseRest(
      "account_members?select=id,account_id,member_name,account_type,legacy_account_type,phone_number,email_address,image_path,allow_guest_entry,is_billing_owner,allow_heater_use&limit=10000"
    ),
    supabaseRest(
      "accounts?select=id,account_number&limit=10000"
    ),
    supabaseRest(
      "account_billing?select=account_id,stripe_status,billing_status,current_period_end,last_sync&limit=10000"
    ).catch(() => [])
  ]);
  const accountById = new Map((accounts || []).map((account) => [account.id, account]));
  const billingByAccountId = new Map((billingRows || []).map((billing) => [billing.account_id, billing]));

  return (members || []).map((member) => {
    const account = accountById.get(member.account_id) || {};
    const billing = billingByAccountId.get(member.account_id) || {};

    return {
      account_member_id: member.id,
      account_id: member.account_id,
      account_number: account.account_number || "",
      member_name: member.member_name || "",
      account_type: member.account_type || "",
      legacy_account_type: member.legacy_account_type || "",
      phone_number: member.phone_number || "",
      email_address: member.email_address || "",
      image_path: member.image_path || "",
      allow_guest_entry: Boolean(member.allow_guest_entry),
      is_billing_owner: Boolean(member.is_billing_owner),
      allow_heater_use: Boolean(member.allow_heater_use),
      stripe_status: billing.stripe_status || "",
      billing_status: billing.billing_status || "",
      current_period_end: billing.current_period_end || null,
      last_sync: billing.last_sync || null
    };
  });
}

function sortDirectoryRows(rows) {
  return [...rows].sort((a, b) => {
    const accountA = String(a.account_number || "");
    const accountB = String(b.account_number || "");
    const accountCompare = accountA.localeCompare(accountB, undefined, { numeric: true, sensitivity: "base" });
    if (accountCompare !== 0) return accountCompare;
    return String(a.member_name || "").localeCompare(String(b.member_name || ""), undefined, { sensitivity: "base" });
  });
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
