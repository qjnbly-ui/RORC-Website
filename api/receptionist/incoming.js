const twilio = require("twilio");
const { DEFAULT_GREETING, MESSAGE_PROMPT, publicHttpUrl, publicWebSocketUrl } = require("../_receptionist");
const { sendTwiML, validateTwilioWebhook } = require("../_twilio-webhook");
const { getCallerAccount } = require("../_rorc-account-phone");

const GREETING_VARIANTS = [
  `You're speaking with the RORC AI receptionist. I know I may sound a little funny at first, but give me a go. I promise I'm more capable than I sound. ${MESSAGE_PROMPT} Otherwise, what can I help you with?`,
  `This is the RORC AI receptionist. Yes, I'm the computer voice, but don't let that fool you. ${MESSAGE_PROMPT} Otherwise, ask me about memberships, rentals, events, projects, or whatever brought you to RORC today.`,
  `You've reached the RORC AI receptionist. I don't drink coffee, but I do know my way around the RORC website. ${MESSAGE_PROMPT} Otherwise, what would you like to know?`,
  `This is RORC's AI receptionist. I may sound a little unusual, but give me a chance. ${MESSAGE_PROMPT} Otherwise, how can I help?`,
  `You're talking with the RORC AI receptionist. The voice may take a second to get used to, but the brain is ready. ${MESSAGE_PROMPT} Otherwise, ask me anything about RORC and I'll do my best to make this easy.`,
];

function rotatingGreeting(firstName = "", random = Math.random) {
  const safeName = String(firstName || "").trim().split(/\s+/)[0];
  const index = Math.min(GREETING_VARIANTS.length - 1, Math.floor(Math.max(0, Number(random()) || 0) * GREETING_VARIANTS.length));
  const intro = GREETING_VARIANTS[index];
  return safeName ? `Welcome back, ${safeName}. ${intro}` : `Thanks for calling the Ruth Obenchain Recreation Center. ${intro}`;
}

function withMessagePrompt(greeting) {
  const message = String(greeting || DEFAULT_GREETING).trim();
  if (/press\s+(?:0|zero)\b/i.test(message)) return message;
  const finalQuestion = message.match(/^(.*?)(\b(?:otherwise,?\s+)?(?:what|how)\b[^?]*\?)$/i);
  return finalQuestion
    ? `${finalQuestion[1].trim()} ${MESSAGE_PROMPT} ${finalQuestion[2]}`
    : `${message} ${MESSAGE_PROMPT}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");
  const callerNumber = String(req.body?.From || req.query?.From || "").trim();
  const caller = await getCallerAccount(callerNumber).catch(() => null);
  const firstName = !caller?.ambiguous
    ? String(caller?.member?.member_name || "").trim().split(/\s+/)[0]
    : "";
  const configuredGreeting = String(process.env.RORC_RECEPTIONIST_GREETING || "").trim();
  const greeting = withMessagePrompt(configuredGreeting || rotatingGreeting(firstName));
  const base = publicHttpUrl(req).replace(/\/api\/receptionist\/incoming(?:\?.*)?$/, "");
  const response = new twilio.twiml.VoiceResponse();
  response.connect({ action: `${base}/api/receptionist/transfer`, method: "POST" }).conversationRelay({
    url: publicWebSocketUrl(req),
    welcomeGreeting: greeting || DEFAULT_GREETING,
    welcomeGreetingInterruptible: "dtmf",
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

module.exports.GREETING_VARIANTS = GREETING_VARIANTS;
module.exports.rotatingGreeting = rotatingGreeting;
module.exports.withMessagePrompt = withMessagePrompt;
