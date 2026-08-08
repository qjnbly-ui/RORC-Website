const twilio = require("twilio");
const { requireAccountManager } = require("./_staff-communications");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const manager = await requireAccountManager(req);
    const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
    const apiKeySid = String(process.env.TWILIO_API_KEY_SID || "").trim();
    const apiKeySecret = String(process.env.TWILIO_API_KEY_SECRET || "").trim();
    const twimlAppSid = String(process.env.TWILIO_TWIML_APP_SID || "").trim();
    if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
      return res.status(503).json({
        success: false,
        error: "Outgoing calling needs its one-time Twilio Voice configuration."
      });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity: `rorc-manager-${manager.id}`,
      ttl: 900
    });
    token.addGrant(new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: false
    }));

    return res.status(200).json({ success: true, token: token.toJwt(), expiresIn: 900 });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Could not prepare outgoing calling."
    });
  }
};
