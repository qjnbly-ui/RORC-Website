const { google } = require("googleapis");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const { member, phone, email } = req.body || {};

    if (!member || !email) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields"
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

    if ([emailCol, phoneCol].includes(-1)) {
      return res.status(400).json({
        success: false,
        error: "Required columns not found"
      });
    }

    const currentEmail = String(member["Email Address"] || "").trim().toLowerCase();
    const currentPhone = String(member["Phone Number"] || "").replace(/\D/g, "");

    let matchedRowIndex = -1;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowEmail = String(row[emailCol] || "").trim().toLowerCase();
      const rowPhone = String(row[phoneCol] || "").replace(/\D/g, "");

      const sameMember =
        (currentEmail && rowEmail === currentEmail) ||
        (currentPhone && rowPhone === currentPhone);

      if (sameMember) {
        matchedRowIndex = i + 2;
        break;
      }
    }

    if (matchedRowIndex === -1) {
      return res.status(400).json({
        success: false,
        error: "Could not find matching member row"
      });
    }

    const emailColLetter = columnToLetter(emailCol + 1);
    const phoneColLetter = columnToLetter(phoneCol + 1);

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          {
            range: `Sheet1!${emailColLetter}${matchedRowIndex}`,
            values: [[email]]
          },
          {
            range: `Sheet1!${phoneColLetter}${matchedRowIndex}`,
            values: [[phone]]
          }
        ]
      }
    });

    return res.status(200).json({
      success: true,
      message: "Account information updated successfully."
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
