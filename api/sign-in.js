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
    const region = process.env.APPSHEET_REGION || "www.appsheet.com";

    if (!appId || !accessKey) {
      return res.status(500).json({
        success: false,
        error: "Missing AppSheet configuration"
      });
    }

    const now = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles"
    });

    const logId = `signin_${Date.now()}`;

    const tableName = encodeURIComponent("Sign In Record");
    const url =
      `https://${region}/api/v2/apps/${appId}/tables/${tableName}/Action`;

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
          "Guest Name": "",
          "Day Pass Or Open Gym": "",
          "Member Entered With": "",
          "Liability Accepted": "",
          "Date/Time In": now,
          "Date/Time Out": "",
          "Total Hours": ""
        }
      ]
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ApplicationAccessKey": accessKey
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({
        success: false,
        error: data?.message || "AppSheet sign-in failed",
        details: data
      });
    }

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
