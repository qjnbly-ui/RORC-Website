const crypto = require("crypto");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONTACT_LINK_TTL_MS = 5 * 60 * 1000;

module.exports = async (req, res) => {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Service role key is not configured." });
  }

  try {
    if (req.method === "POST") {
      const sessionToken = bearerToken(req);
      if (!sessionToken) {
        return res.status(401).json({ success: false, error: "Missing session token." });
      }

      const user = await getSupabaseUser(sessionToken);
      const manager = await getAccountMemberByAuthUserId(user.id);
      if (!manager || manager.account_type !== "Account Manager") {
        return res.status(403).json({ success: false, error: "Only account managers can save member contacts." });
      }

      const memberId = stringValue(req.body?.memberId);
      if (!memberId) {
        return res.status(400).json({ success: false, error: "Missing member ID." });
      }

      await loadContact(memberId);
      const downloadToken = createDownloadToken(memberId);
      return res.status(200).json({
        success: true,
        downloadUrl: `/api/member-contact?token=${encodeURIComponent(downloadToken)}`
      });
    }

    if (req.method === "GET") {
      const memberId = verifyDownloadToken(stringValue(req.query?.token));
      const contact = await loadContact(memberId);
      const card = buildVCard(contact);
      const fileName = `${safeFileName(contact.memberName)}.vcf`;

      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("Content-Type", "text/vcard; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(`\ufeff${card}`);
    }

    return res.status(405).json({ success: false, error: "Method not allowed." });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message || "Could not prepare member contact." });
  }
};

async function loadContact(memberId) {
  const memberRows = await supabaseRest(
    `account_members?select=id,account_id,member_name,account_type,phone_number,email_address&id=eq.${encodeURIComponent(memberId)}&limit=1`
  );
  const member = memberRows[0];
  if (!member) throw httpError(404, "Member was not found.");

  const [accountRows, contracts] = await Promise.all([
    supabaseRest(`accounts?select=account_number&id=eq.${encodeURIComponent(member.account_id)}&limit=1`),
    supabaseRest(
      `signup_contracts?select=primary_member_id,contract_payload,created_at&account_id=eq.${encodeURIComponent(member.account_id)}&order=created_at.desc&limit=50`
    ).catch(() => [])
  ]);
  const memberContract = contracts.find((contract) => contract.primary_member_id === member.id);
  const addressContract = memberContract || contracts.find((contract) => (
    stringValue(contract?.contract_payload?.primary?.address)
  ));

  return {
    memberName: member.member_name || "RORC Member",
    accountType: member.account_type || "",
    phoneNumber: member.phone_number || "",
    emailAddress: member.email_address || "",
    mailingAddress: stringValue(addressContract?.contract_payload?.primary?.address),
    accountNumber: accountRows[0]?.account_number || ""
  };
}

function createDownloadToken(memberId) {
  const payload = Buffer.from(JSON.stringify({
    memberId,
    expiresAt: Date.now() + CONTACT_LINK_TTL_MS
  })).toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

function verifyDownloadToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) throw httpError(401, "This contact link is invalid.");

  const expected = Buffer.from(signPayload(payload));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw httpError(401, "This contact link is invalid.");
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw httpError(401, "This contact link is invalid.");
  }

  if (!decoded.memberId || !decoded.expiresAt || Date.now() > Number(decoded.expiresAt)) {
    throw httpError(401, "This contact link has expired.");
  }
  return String(decoded.memberId);
}

function signPayload(payload) {
  return crypto.createHmac("sha256", SERVICE_ROLE_KEY).update(payload).digest("base64url");
}

function buildVCard(contact) {
  const name = stringValue(contact.memberName) || "RORC Member";
  const nameParts = name.split(/\s+/).filter(Boolean);
  const familyName = nameParts.length > 1 ? nameParts.pop() : "";
  const givenName = nameParts.join(" ") || name;
  const note = [
    contact.accountNumber ? `RORC Account ${contact.accountNumber}` : "RORC Account",
    contact.accountType
  ].filter(Boolean).join(" · ");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escapeVCardValue(familyName)};${escapeVCardValue(givenName)};;;`,
    `FN:${escapeVCardValue(name)}`,
    "ORG:Ruth Obenchain Recreation Center"
  ];

  if (contact.phoneNumber) lines.push(`TEL;TYPE=CELL:${escapeVCardValue(contact.phoneNumber)}`);
  if (contact.emailAddress) lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(contact.emailAddress)}`);
  if (contact.mailingAddress) lines.push(`ADR;TYPE=HOME:;;${escapeVCardValue(contact.mailingAddress)};;;;`);
  if (note) lines.push(`NOTE:${escapeVCardValue(note)}`);
  lines.push("END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
}

function escapeVCardValue(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

function safeFileName(value) {
  return stringValue(value)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "RORC-Member";
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
  if (!response.ok) throw httpError(401, "Invalid session.");
  return response.json();
}

async function getAccountMemberByAuthUserId(authUserId) {
  const rows = await supabaseRest(
    `account_members?select=id,account_type&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
  );
  return rows[0] || null;
}

async function supabaseRest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST request failed: ${response.status} ${text}`);
  }
  return response.json();
}

function stringValue(value) {
  return String(value || "").trim();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports._test = {
  buildVCard,
  createDownloadToken,
  verifyDownloadToken
};
