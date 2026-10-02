const DEFAULT_GREETING = "Thanks for calling the Ruth Obenchain Recreation Center. You're speaking with the RORC AI receptionist. How can I help you today?";
// Jessica: ElevenLabs' premade American conversational voice.
// Keep the selection here so new calls and reconnects use the same voice.
const RECEPTIONIST_VOICE = "cgSgspJ2msm6clMCkdW9";

function escapeXml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function publicHost(req) {
  return String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "ruthobenchainrc.com").split(",")[0].trim();
}

function publicHttpUrl(req, path = req?.url || "/api/receptionist/incoming") {
  return `https://${publicHost(req)}${path}`;
}

function publicWebSocketUrl(req) {
  return `wss://${publicHost(req)}/api/receptionist/conversation`;
}

function toSpeechText(value) {
  return String(value || "").replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim();
}

function buildTwiML({ websocketUrl, actionUrl, greeting = DEFAULT_GREETING, voice = RECEPTIONIST_VOICE }) {
  const voiceAttribute = voice ? ` voice="${escapeXml(voice)}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect action="${escapeXml(actionUrl)}" method="POST">\n    <ConversationRelay url="${escapeXml(websocketUrl)}" welcomeGreeting="${escapeXml(greeting)}" welcomeGreetingInterruptible="none" reportInputDuringAgentSpeech="none" language="en-US" transcriptionProvider="Deepgram" ttsProvider="ElevenLabs"${voiceAttribute} interruptSensitivity="low" speechTimeout="1200" ignoreBackchannel="true" dtmfDetection="true" />\n  </Connect>\n</Response>`;
}

module.exports = { DEFAULT_GREETING, RECEPTIONIST_VOICE, buildTwiML, publicHttpUrl, publicWebSocketUrl, toSpeechText };
