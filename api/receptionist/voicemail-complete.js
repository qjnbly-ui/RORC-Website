const twilio = require("twilio");
const { sendTwiML, validateTwilioWebhook } = require("../_twilio-webhook");

module.exports = function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");
  const response = new twilio.twiml.VoiceResponse();
  const recordingSid = String(req.body?.RecordingSid || "").trim();
  const duration = Number(req.body?.RecordingDuration || 0);
  if (recordingSid && duration > 0) {
    response.say({ voice: "alice" }, "Thank you. Your voicemail has been recorded for the RORC team. Goodbye.");
  } else {
    response.say({ voice: "alice" }, "I did not receive a voicemail. Please call again if you would still like to leave a message. Goodbye.");
  }
  response.hangup();
  return sendTwiML(res, response);
};
