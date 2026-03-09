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

    const url =
      `https://${region}/api/v2/apps/${appId}/tables/TimeSheet/Action`;

    // 1. Find active sign-in
    const findPayload = {
      Action: "Find",
      Properties: {},
      Selector: `FILTER("TimeSheet", AND(([Name] = "${memberName}"), ISBLANK([Date/Time Out])))`
    };

    const findResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ApplicationAccessKey": accessKey
      },
      body: JSON.stringify(findPayload)
    });

    const findData = await findResponse.json();

    if (!findResponse.ok) {
      return res.status(400).json({
        success: false,
        error: findData?.message || "AppSheet sign-out lookup failed",
        details: findData
      });
    }

    const rows = findData.Rows || findData.rows || [];

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        error: "No active sign-in found"
      });
    }

    // Use the most recent matching row
    const targetRow = rows[rows.length - 1];

    const now = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles"
    });

    // 2. Edit that row
    const editPayload = {
      Action: "Edit",
      Properties: {
        Locale: "en-US",
        Timezone: "America/Los_Angeles"
      },
      Rows: [
        {
          "Log ID": targetRow["Log ID"],
          "Date/Time Out": now
        }
      ]
    };

    const editResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ApplicationAccessKey": accessKey
      },
      body: JSON.stringify(editPayload)
    });

    const editData = await editResponse.json();

    if (!editResponse.ok) {
      return res.status(400).json({
        success: false,
        error: editData?.message || "AppSheet sign-out update failed",
        details: editData
      });
    }

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