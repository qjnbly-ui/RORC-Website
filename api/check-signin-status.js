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
      Selector: `FILTER("TimeSheet", AND(([Name] = "${memberName}"), ISBLANK([Date/Time Out])))`
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
        signedInAt: null
      });
    }

    const latestRow = rows[rows.length - 1];

    return res.json({
      success: true,
      signedIn: true,
      signedInAt: latestRow["Date/Time In"] || null,
      logId: null
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: err.message
    });
  }
};
