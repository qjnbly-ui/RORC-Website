const { google } = require("googleapis");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const { member } = req.body || {};
    if (!member || typeof member !== "object") {
      return res.status(400).json({
        success: false,
        authenticated: false,
        error: "Missing member data"
      });
    }

    const memberName = String(member["Member Name"] || "").trim();
    const accountNumber = String(member["Account Number"] || "").trim();
    const email = String(member["Email Address"] || "").trim().toLowerCase();

    if (!memberName || (!accountNumber && !email)) {
      return res.status(400).json({
        success: false,
        authenticated: false,
        error: "Missing member identifiers"
      });
    }

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    });
    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: "14ZMpY36GnDXXGplOJwzGZiUBlqv3F95E9ve-pwlLzYk",
      range: "Sheet1!A1:Q"
    });

    const rows = response.data.values || [];
    if (!rows.length) {
      return res.json({
        success: true,
        authenticated: false
      });
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);
    const nameCol = headers.indexOf("Member Name");
    const accountCol = headers.indexOf("Account Number");
    const emailCol = headers.indexOf("Email Address");

    if (nameCol === -1 || accountCol === -1 || emailCol === -1) {
      return res.status(500).json({
        success: false,
        authenticated: false,
        error: "Required columns not found"
      });
    }

    const matchedRow = dataRows.find((row) => {
      const rowName = String(row[nameCol] || "").trim();
      const rowAccountNumber = String(row[accountCol] || "").trim();
      const rowEmail = String(row[emailCol] || "").trim().toLowerCase();

      if (rowName !== memberName) {
        return false;
      }

      if (accountNumber && rowAccountNumber) {
        return rowAccountNumber === accountNumber;
      }

      return !!email && rowEmail === email;
    });

    if (!matchedRow) {
      return res.json({
        success: true,
        authenticated: false
      });
    }

    const verifiedMember = {};
    headers.forEach((header, index) => {
      verifiedMember[header] = matchedRow[index] || "";
    });

    delete verifiedMember.Password;

    return res.json({
      success: true,
      authenticated: true,
      member: verifiedMember
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      authenticated: false,
      error: "Server error",
      details: error.message
    });
  }
};
