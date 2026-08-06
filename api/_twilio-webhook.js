const twilio = require("twilio");
const { publicHttpUrl } = require("./_receptionist");

function validateTwilioWebhook(req) {
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const signature = String(req.headers?.["x-twilio-signature"] || "").trim();
  if (!token || !signature) return false;
  return twilio.validateRequest(token, signature, publicHttpUrl(req), req.body || {});
}

function sendTwiML(res, response) {
  res.setHeader("Content-Type", "text/xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(response.toString());
}

module.exports = { validateTwilioWebhook, sendTwiML };
