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

    const tableName = encodeURIComponent("Sign In Record");
    const url = `https://api.appsheet.com/api/v2/apps/${appId}/tables/${tableName}/Action`;

    const now = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles"
    });

    const logId = `signin_${Date.now()}`;

    const payload = {
      Action: "Add",
      Properties: {
        Locale: "en-US",
        Timezone: "America/Los_Angeles"
      },
      Rows: [
        {
          "Log ID": logId,
          "Member  or Guest": "Member",
          "Name": memberName,
          "Date/Time In": now
        }
      ]
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
        error: "AppSheet sign-in failed",
        details: data
      });
    }

    return res.status(200).json({
      success: true,
      logId,
      message: "Sign-in request sent successfully"
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: err.message
    });
  }
};
