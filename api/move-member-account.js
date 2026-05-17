const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      success: false,
      error: "Supabase service role key is not configured"
    });
  }

  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Missing Supabase session"
      });
    }

    const user = await getSupabaseUser(token);
    const manager = await getAccountMemberByAuthUserId(user.id);

    if (!manager || manager.account_type !== "Account Manager") {
      return res.status(403).json({
        success: false,
        error: "Only account managers can move profiles between accounts."
      });
    }

    const memberId = String(req.body?.memberId || "").trim();
    const targetAccountNumber = String(req.body?.targetAccountNumber || "").trim();

    if (!memberId || !targetAccountNumber) {
      return res.status(400).json({
        success: false,
        error: "memberId and targetAccountNumber are required."
      });
    }

    const member = await getAccountMemberById(memberId);
    if (!member) {
      return res.status(404).json({
        success: false,
        error: "Member not found."
      });
    }

    let targetAccount = await getAccountByNumber(targetAccountNumber);

    if (!targetAccount) {
      targetAccount = await createAccount(targetAccountNumber);
    }

    if (member.account_id === targetAccount.id) {
      return res.status(200).json({ success: true });
    }

    if (member.is_billing_owner) {
      const existingBillingOwner = await getBillingOwnerForAccount(targetAccount.id);
      if (existingBillingOwner) {
        return res.status(409).json({
          success: false,
          error: "Target account already has a billing owner. Remove billing owner first or move a non-billing-owner profile."
        });
      }
    }

    await updateMemberAccount(memberId, targetAccount.id);

    return res.status(200).json({
      success: true,
      targetAccountId: targetAccount.id,
      targetAccountNumber
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
};

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
    throw new Error("Invalid Supabase session");
  }

  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const params = new URLSearchParams({
    select: "id,account_id,account_type,is_billing_owner",
    auth_user_id: `eq.${authUserId}`,
    limit: "1"
  });

  const rows = await supabaseRest(`account_members?${params.toString()}`);
  return rows[0] || null;
}

async function getAccountMemberById(memberId) {
  const params = new URLSearchParams({
    select: "id,account_id,is_billing_owner",
    id: `eq.${memberId}`,
    limit: "1"
  });

  const rows = await supabaseRest(`account_members?${params.toString()}`);
  return rows[0] || null;
}

async function getAccountByNumber(accountNumber) {
  const params = new URLSearchParams({
    select: "id,account_number",
    account_number: `eq.${accountNumber}`,
    limit: "1"
  });

  const rows = await supabaseRest(`accounts?${params.toString()}`);
  return rows[0] || null;
}

async function createAccount(accountNumber) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/accounts`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      account_number: accountNumber
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not create account: ${response.status} ${text}`);
  }

  const rows = await response.json();
  return rows[0] || null;
}

async function getBillingOwnerForAccount(accountId) {
  const params = new URLSearchParams({
    select: "id",
    account_id: `eq.${accountId}`,
    is_billing_owner: "eq.true",
    limit: "1"
  });

  const rows = await supabaseRest(`account_members?${params.toString()}`);
  return rows[0] || null;
}

async function updateMemberAccount(memberId, accountId) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/account_members?id=eq.${memberId}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      account_id: accountId
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not move member: ${response.status} ${text}`);
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
    throw new Error(`Supabase REST request failed: ${response.status} ${text}`);
  }

  return response.json();
}
