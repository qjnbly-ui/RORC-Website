const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15416526065";
const GYM_OPEN_TO_NUMBER = "+15418916772";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return res.status(500).json({
      success: false,
      error: "Twilio credentials are not configured."
    });
  }

  try {
    const memberName = String(req.body?.memberName || req.body?.name || "Unknown").trim() || "Unknown";
    const toNumber = String(req.body?.to || GYM_OPEN_TO_NUMBER).trim() || GYM_OPEN_TO_NUMBER;
    const body = `GYM LIGHTS ON\nMember Entered: ${memberName}`;

    const auth = Buffer
      .from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)
      .toString("base64");

    const params = new URLSearchParams({
      To: toNumber,
      From: TWILIO_FROM_NUMBER,
      Body: body
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        error: result?.message || "Twilio SMS request failed."
      });
    }

    return res.status(200).json({
      success: true,
      sid: result.sid
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
};
