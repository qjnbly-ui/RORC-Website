const twilio = require("twilio");
const { validateTwilioWebhook, sendTwiML } = require("./_twilio-webhook");
const { RORC_PHONE } = require("./_staff-communications");
const { normalizePhone } = require("./_rorc-sms");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");

  const response = new twilio.twiml.VoiceResponse();
  const recipient = normalizePhone(req.body?.To);
  if (!recipient || !RORC_PHONE) {
    response.say("This call could not be completed because the phone number was invalid.");
    response.hangup();
    return sendTwiML(res, response);
  }

  response.dial({
    callerId: RORC_PHONE,
    answerOnBridge: true,
    timeout: 30
  }).number(recipient);
  return sendTwiML(res, response);
};
