const { google } = require("googleapis");
const path = require("path");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { login, pin } = req.body || {};

    if (!login || !pin) {
      return res.status(400).json({
        success: false,
        error: "Missing login or PIN"
      });
    }

    const normalizedLogin = String(login).trim().toLowerCase();
    const normalizedPhone = normalizedLogin.replace(/\D/g, "");
    const normalizedPin = String(pin).trim();

    const keyFile = path.join(process.cwd(), "lib", "google-service-account.json");

    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    });

    const sheets = google.sheets({ version: "v4", auth });

    const spreadsheetId = "14ZMpY36GnDXXGplOJwzGZiUBlqv3F95E9ve-pwlLzYk";

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:Q"
    });

    const rows = response.data.values || [];

    if (!rows.length) {
      return res.json({
        success: false,
        error: "Membership sheet empty"
      });
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);

    const nameCol = headers.indexOf("Member Name");
    const passCol = headers.indexOf("Password");
    const phoneCol = headers.indexOf("Phone Number");
    const emailCol = headers.indexOf("Email Address");

    if ([nameCol, passCol, phoneCol, emailCol].includes(-1)) {
      return res.json({
        success: false,
        error: "Required columns not found",
        headers
      });
    }

    for (const row of dataRows) {
      const name = String(row[nameCol] || "").trim();
      const password = String(row[passCol] || "").trim();
      const phone = String(row[phoneCol] || "").replace(/\D/g, "");
      const email = String(row[emailCol] || "").trim().toLowerCase();

      const loginMatches =
        normalizedLogin === email ||
        (normalizedPhone && normalizedPhone === phone);

      if (loginMatches && normalizedPin === password) {
        return res.json({
          success: true,
          name
        });
      }
    }

    return res.json({
      success: false,
      error: "Invalid login"
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message
    });
  }
};