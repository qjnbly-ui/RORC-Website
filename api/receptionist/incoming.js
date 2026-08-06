const twilio = require("twilio");
const { DEFAULT_GREETING, publicHttpUrl, publicWebSocketUrl } = require("../_receptionist");
const { sendTwiML, validateTwilioWebhook } = require("../_twilio-webhook");

module.exports = function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");
  const base = publicHttpUrl(req).replace(/\/api\/receptionist\/incoming(?:\?.*)?$/, "");
  const response = new twilio.twiml.VoiceResponse();
  response.connect({ action: `${base}/api/receptionist/transfer`, method: "POST" }).conversationRelay({
    url: publicWebSocketUrl(req),
    welcomeGreeting: String(process.env.RORC_RECEPTIONIST_GREETING || DEFAULT_GREETING),
    welcomeGreetingInterruptible: "none",
    reportInputDuringAgentSpeech: "speech",
    language: "en-US",
    transcriptionProvider: "Deepgram",
    ttsProvider: "ElevenLabs",
    voice: String(process.env.TWILIO_RECEPTIONIST_VOICE || ""),
    interruptSensitivity: "low",
    speechTimeout: "1200",
    ignoreBackchannel: "true",
    dtmfDetection: "true",
  });
  return sendTwiML(res, response);
};
