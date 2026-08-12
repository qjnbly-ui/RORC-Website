const twilio = require("twilio");
const { buildTwiML, publicHttpUrl, publicWebSocketUrl } = require("../_receptionist");
const { sendTwiML, validateTwilioWebhook } = require("../_twilio-webhook");

function handoffData(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");
  const handoff = handoffData(req.body?.HandoffData);
  if (handoff.reasonCode !== "approved-rorc-transfer") {
    const retry = Math.max(0, Number(req.query?.relayRetry || 0));
    if (retry < 1) {
      const base = publicHttpUrl(req).replace(/\/api\/receptionist\/transfer(?:\?.*)?$/, "");
      return sendTwiML(res, buildTwiML({
        websocketUrl: publicWebSocketUrl(req),
        actionUrl: `${base}/api/receptionist/transfer?relayRetry=1`,
        greeting: "The call connection was restored. Please continue with your question.",
        voice: String(process.env.TWILIO_RECEPTIONIST_VOICE || ""),
      }));
    }
    const ended = new twilio.twiml.VoiceResponse();
    ended.say({ voice: "alice" }, "The automated connection ended. Please call RORC again so the receptionist can continue helping you.");
    return sendTwiML(res, ended);
  }
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

module.exports.handoffData = handoffData;
