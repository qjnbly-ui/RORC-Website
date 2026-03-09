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

    if (!member) {
      return res.status(400).json({
        success: false,
        error: "Missing member data"
      });
    }

    const memberName = String(member["Member Name"] || "").trim();

    if (!memberName) {
      return res.status(400).json({
        success: false,
        error: "Missing member name"
      });
    }

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = "1yXt9rZEcEosqAgI0xg-xY4qhjx19ovlb4InyLtKKc0E";

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "TimeSheet!A1:J"
    });

    const rows = response.data.values || [];
    const headers = rows[0] || [];
    const dataRows = rows.slice(1);

    const nameCol = headers.indexOf("Name");
    const outCol = headers.indexOf("Date/Time Out");

    if ([nameCol, outCol].includes(-1)) {
      return res.status(400).json({
        success: false,
        error: "Required columns not found"
      });
    }

    let matchedRowIndex = -1;

    for (let i = dataRows.length - 1; i >= 0; i--) {
      const row = dataRows[i];
      const rowName = String(row[nameCol] || "").trim();
      const rowOut = String(row[outCol] || "").trim();

      if (rowName === memberName && !rowOut) {
        matchedRowIndex = i + 2;
        break;
      }
    }

    if (matchedRowIndex === -1) {
      return res.status(400).json({
        success: false,
        error: "No active sign-in found"
      });
    }

    const now = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles"
    });

    const outColLetter = columnToLetter(outCol + 1);

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `TimeSheet!${outColLetter}${matchedRowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[now]]
      }
    });

    return res.status(200).json({
      success: true,
      message: "Signed out successfully"
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
