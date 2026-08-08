const twilio = require("twilio");
const { publicHttpUrl } = require("../_receptionist");
const { validateTwilioWebhook, sendTwiML } = require("../_twilio-webhook");
const { consent } = require("../_rorc-sms");
const { recordIncomingMessage } = require("../_staff-communications");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");
  const from = String(req.body?.From || "").trim();
  const body = String(req.body?.Body || "").trim().toLowerCase();
  const response = new twilio.twiml.MessagingResponse();
  await recordIncomingMessage(req.body || {}).catch((error) => {
    console.error("Incoming staff message could not be saved.", error);
  });
  if (/^(start|unstop|yes|subscribe)$/i.test(body)) {
    await consent(from, "opt_in", "inbound_sms");
    response.message("RORC texts are now enabled for requested information. Message frequency varies. Reply STOP to opt out or HELP for help.");
  } else if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(body)) {
    await consent(from, "opt_out", "inbound_sms");
    response.message("RORC texts are disabled. Reply START to opt in again or HELP for help.");
  } else if (/^help$/i.test(body)) {
    response.message("RORC SMS help: text START to opt in or STOP to opt out. For support, call (541) 652-6065.");
  }
  return sendTwiML(res, response);
};
