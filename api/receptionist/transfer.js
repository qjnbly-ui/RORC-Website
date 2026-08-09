const twilio = require("twilio");
const { publicHttpUrl } = require("../_receptionist");
const { sendTwiML, validateTwilioWebhook } = require("../_twilio-webhook");

module.exports = function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");
  const number = String(process.env.RORC_RECEPTIONIST_TRANSFER_NUMBER || "").trim();
  const response = new twilio.twiml.VoiceResponse();
  if (!number) {
    response.say({ voice: "alice" }, "The RORC team is not available for a live transfer yet. Please call the facility directly during normal hours.");
    return sendTwiML(res, response);
  }
  response.say({ voice: "alice" }, "Please hold while I connect you with the RORC team.");
  response.dial({ action: `${publicHttpUrl(req).replace(/\/api\/receptionist\/transfer(?:\?.*)?$/, "")}/api/receptionist/transfer-complete`, method: "POST", timeout: 25 }, number);
  return sendTwiML(res, response);
};
