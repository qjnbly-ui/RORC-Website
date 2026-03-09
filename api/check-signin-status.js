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
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    });

    const sheets = google.sheets({ version: "v4", auth });

    const spreadsheetId = "1yXt9rZEcEosqAgI0xg-xY4qhjx19ovlb4InyLtKKc0E";

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "TimeSheet!A1:J"
    });

    const rows = response.data.values || [];

    if (!rows.length) {
      return res.json({
        success: true,
        signedIn: false
      });
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);

    const nameCol = headers.indexOf("Name");
    const inCol = headers.indexOf("Date/Time In");
    const outCol = headers.indexOf("Date/Time Out");

    if ([nameCol, inCol, outCol].includes(-1)) {
      return res.status(400).json({
        success: false,
        error: "Required columns not found"
      });
    }

    let activeRecord = null;

    for (let i = dataRows.length - 1; i >= 0; i--) {
      const row = dataRows[i];
      const rowName = String(row[nameCol] || "").trim();
      const timeIn = String(row[inCol] || "").trim();
      const timeOut = String(row[outCol] || "").trim();

      if (rowName === memberName && timeIn && !timeOut) {
        activeRecord = {
          signedInAt: timeIn
        };
        break;
      }
    }

    return res.json({
      success: true,
      signedIn: !!activeRecord,
      signedInAt: activeRecord ? activeRecord.signedInAt : null
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message
    });
  }
};
