const test = require("node:test");
const assert = require("node:assert/strict");
const twilio = require("twilio");
const receptionist = require("../api/receptionist/conversation");
const { buildTwiML } = require("../api/_receptionist");
const {
  VOICEMAIL_MAX_SECONDS,
  appendVoicemailRecording,
  isVoicemailHandoff,
  parseHandoffData,
} = require("../api/_receptionist-voicemail");

test("ConversationRelay lets zero interrupt the greeting and requests voicemail globally", () => {
  const xml = buildTwiML({
    websocketUrl: "wss://example.com/conversation",
    actionUrl: "https://example.com/transfer",
  });
  assert.match(xml, /welcomeGreetingInterruptible="dtmf"/);
  assert.match(xml, /dtmfDetection="true"/);
  assert.equal(receptionist.isVoicemailRequest({ type: "dtmf", digit: "0" }), true);
  assert.equal(receptionist.isVoicemailRequest({ type: "dtmf", digit: "1" }), false);
  assert.deepEqual(JSON.parse(receptionist.voicemailHandoffMessage().handoffData), { reasonCode: "voicemail" });
});

test("voicemail handoff parsing fails closed", () => {
  assert.deepEqual(parseHandoffData("not-json"), {});
  assert.equal(isVoicemailHandoff({ body: { HandoffData: JSON.stringify({ reasonCode: "voicemail" }) } }), true);
  assert.equal(isVoicemailHandoff({ body: { HandoffData: JSON.stringify({ reasonCode: "approved-rorc-transfer" }) } }), false);
});

test("voicemail flow obtains consent and creates a real Twilio recording", () => {
  const response = new twilio.twiml.VoiceResponse();
  appendVoicemailRecording(response, {
    headers: { host: "www.ruthobenchainrc.com" },
    url: "/api/receptionist/transfer",
  });
  const xml = response.toString();

  assert.match(xml, /Your message will be recorded/);
  assert.match(xml, /<Record/);
  assert.match(xml, /action="https:\/\/www\.ruthobenchainrc\.com\/api\/receptionist\/voicemail-complete"/);
  assert.match(xml, /recordingStatusCallback="https:\/\/www\.ruthobenchainrc\.com\/api\/receptionist\/voicemail-status"/);
  assert.match(xml, /finishOnKey="#"/);
  assert.match(xml, new RegExp(`maxLength="${VOICEMAIL_MAX_SECONDS}"`));
});
