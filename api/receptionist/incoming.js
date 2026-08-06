const twilio = require("twilio");
const { DEFAULT_GREETING, publicHttpUrl, publicWebSocketUrl } = require("../_receptionist");
const { sendTwiML, validateTwilioWebhook } = require("../_twilio-webhook");
const { getCallerAccount } = require("../_rorc-account-phone");

module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");
  const callerNumber = String(req.body?.From || req.query?.From || "").trim();
  const caller = await getCallerAccount(callerNumber).catch(() => null);
  const firstName = !caller?.ambiguous
    ? String(caller?.member?.member_name || "").trim().split(/\s+/)[0]
    : "";
  const recognizedGreeting = firstName
    ? `Welcome back, ${firstName}. You're speaking with the RORC AI receptionist. How can I help you today?`
    : "";
  const base = publicHttpUrl(req).replace(/\/api\/receptionist\/incoming(?:\?.*)?$/, "");
  const response = new twilio.twiml.VoiceResponse();
  response.connect({ action: `${base}/api/receptionist/transfer`, method: "POST" }).conversationRelay({
    url: publicWebSocketUrl(req),
    welcomeGreeting: recognizedGreeting || String(process.env.RORC_RECEPTIONIST_GREETING || DEFAULT_GREETING),
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
