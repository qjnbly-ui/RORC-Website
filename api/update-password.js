const { google } = require("googleapis");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const { member, currentPin, newPin } = req.body || {};

    if (!member || !currentPin || !newPin) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields"
      });
    }

    if (!/^\d{4}$/.test(String(newPin))) {
      return res.status(400).json({
        success: false,
        error: "New password must be exactly 4 digits"
      });
    }

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = "14ZMpY36GnDXXGplOJwzGZiUBlqv3F95E9ve-pwlLzYk";

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:Q"
    });

    const rows = response.data.values || [];

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        error: "Membership sheet empty"
      });
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);

    const emailCol = headers.indexOf("Email Address");
    const phoneCol = headers.indexOf("Phone Number");
    const passCol = headers.indexOf("Password");

    if ([emailCol, phoneCol, passCol].includes(-1)) {
      return res.status(400).json({
        success: false,
        error: "Required columns not found"
      });
    }

    const targetEmail = String(member["Email Address"] || "").trim().toLowerCase();
    const targetPhone = String(member["Phone Number"] || "").replace(/\D/g, "");
    const current = String(currentPin).trim();

    let matchedRowIndex = -1;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowEmail = String(row[emailCol] || "").trim().toLowerCase();
      const rowPhone = String(row[phoneCol] || "").replace(/\D/g, "");
      const rowPassword = String(row[passCol] || "").trim();

      const sameMember =
        (targetEmail && rowEmail === targetEmail) ||
        (targetPhone && rowPhone === targetPhone);

      if (sameMember && rowPassword === current) {
        matchedRowIndex = i + 2; // sheet row number
        break;
      }
    }

    if (matchedRowIndex === -1) {
      return res.status(400).json({
        success: false,
        error: "Current password is incorrect"
      });
    }

    const passwordColLetter = columnToLetter(passCol + 1);

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!${passwordColLetter}${matchedRowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[String(newPin)]]
      }
    });

    return res.status(200).json({
      success: true,
      message: "Password updated successfully"
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message
    });
  }
};

function columnToLetter(column) {
  let temp = "";
  let letter = "";
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}
