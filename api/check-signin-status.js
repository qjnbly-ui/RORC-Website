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

    const appId = process.env.APPSHEET_APP_ID;
    const accessKey = process.env.APPSHEET_ACCESS_KEY;

    if (!appId || !accessKey) {
      return res.status(500).json({
        success: false,
        error: "Missing AppSheet configuration"
      });
    }

    const tableName = encodeURIComponent("TimeSheet");
    const url = `https://api.appsheet.com/api/v2/apps/${appId}/tables/${tableName}/Action`;

    const payload = {
      Action: "Find",
      Properties: {
        UserSettings: {
          "Member Account": memberName
        }
      },
      Selector: `FILTER("TimeSheet", (TRIM([Name]) = TRIM("${memberName}")))`
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "ApplicationAccessKey": accessKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      return res.status(400).json({
        success: false,
        error: "AppSheet status check failed",
        details: data
      });
    }

    const rows = data.Rows || data.rows || [];

    if (!rows.length) {
      return res.json({
        success: true,
        signedIn: false,
        signedInAt: null,
        ...(req.body && req.body.debug ? {
          debug: {
            memberName,
            selector: payload.Selector,
            rowCount: 0
          }
        } : {})
      });
    }

    const openRows = rows.filter((row) => {
      const outValue = row["Date/Time Out"];
      return outValue === null || outValue === undefined || String(outValue).trim() === "";
    });

    if (!openRows.length) {
      return res.json({
        success: true,
        signedIn: false,
        signedInAt: null,
        ...(req.body && req.body.debug ? {
          debug: {
            memberName,
            selector: payload.Selector,
            rowCount: rows.length
          }
        } : {})
      });
    }

    const latestRow = openRows.reduce((latest, row) => {
      const latestTime = Date.parse(latest["Date/Time In"] || "") || 0;
      const rowTime = Date.parse(row["Date/Time In"] || "") || 0;
      return rowTime >= latestTime ? row : latest;
    }, openRows[0]);

    return res.json({
      success: true,
      signedIn: true,
      signedInAt: latestRow["Date/Time In"] || null,
      logId: null,
      ...(req.body && req.body.debug ? {
        debug: {
          memberName,
          selector: payload.Selector,
          rowCount: rows.length,
          latestRow: {
            "Log ID": latestRow["Log ID"],
            "Name": latestRow["Name"],
            "Member  or Guest": latestRow["Member  or Guest"],
            "Date/Time In": latestRow["Date/Time In"],
            "Date/Time Out": latestRow["Date/Time Out"]
          }
        }
      } : {})
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: err.message
    });
  }
};
