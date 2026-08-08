const twilio = require("twilio");
const { appendVoicemailRecording } = require("../_receptionist-voicemail");
const { sendTwiML, validateTwilioWebhook } = require("../_twilio-webhook");

module.exports = function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");
  const response = new twilio.twiml.VoiceResponse();
  const dialStatus = String(req.body?.DialCallStatus || "").toLowerCase();
  if (dialStatus === "completed") {
    response.hangup();
    return sendTwiML(res, response);
  }
  appendVoicemailRecording(response, req, "I'm sorry, nobody is available right now.");
  return sendTwiML(res, response);
};
