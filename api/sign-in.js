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

    const readResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "TimeSheet!A1:J"
    });

    const rows = readResponse.data.values || [];
    const headers = rows[0] || [];

    const nameCol = headers.indexOf("Name");
    const inCol = headers.indexOf("Date/Time In");
    const outCol = headers.indexOf("Date/Time Out");

    if ([nameCol, inCol, outCol].includes(-1)) {
      return res.status(400).json({
        success: false,
        error: "Required columns not found"
      });
    }

    const dataRows = rows.slice(1);

    for (let i = dataRows.length - 1; i >= 0; i--) {
      const row = dataRows[i];
      const rowName = String(row[nameCol] || "").trim();
      const rowIn = String(row[inCol] || "").trim();
      const rowOut = String(row[outCol] || "").trim();

      if (rowName === memberName && rowIn && !rowOut) {
        return res.status(400).json({
          success: false,
          error: "You are already signed in"
        });
      }
    }

    const now = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles"
    });

    const logId = `signin_${Date.now()}`;

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "TimeSheet!A:J",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          logId,        // Log ID
          "Member",     // Member or Guest
          memberName,   // Name
          "",           // Guest Name
          "",           // Day Pass Or Open Gym
          "",           // Member Entered With
          "",           // Liability Accepted
          now,          // Date/Time In
          "",           // Date/Time Out
          ""            // Total Hours
        ]]
      }
    });

    return res.status(200).json({
      success: true,
      message: "Signed in successfully"
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message
    });
  }
};
